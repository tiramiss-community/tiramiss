/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { DataSource, IsNull, Not } from '../../../../packages/backend-next/node_modules/typeorm/index.js';
import { MiAnnouncement } from '../../../../packages/backend-upstream/built/exports/entities.js';
import { createDataSource } from '../../../../packages/backend-next/built/platform/database/data-source.js';
import { migrateDatabase } from '../../../../packages/backend-next/built/platform/database/migrate.js';
import { baseQueueOptions, baseWorkerOptions } from '../../../../packages/backend-next/built/platform/job-queue/connection.js';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { Queue, Worker } = require('bullmq');
const root = new URL('../../../../', import.meta.url);
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = [];
let clock = Date.parse(corpus.now);
class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [clock])); }
	static now() { return clock; }
}
function methods(path, names) {
	const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: root });
	manifest.push({ path, gitBlob: execFileSync('git', ['rev-parse', `${pin}:${path}`], { cwd: root }).toString().trim(), sha256: hash(bytes) });
	const source = ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
	const cls = source.statements.find(ts.isClassDeclaration);
	const selected = names.map(name => {
		const method = cls.members.find(member => member.name?.getText(source) === name);
		assert(method, name);
		return method.getText(source).replaceAll(/@bindThis\s*/g, '');
	});
	return vm.runInNewContext(ts.transpile(`(class { ${selected.join('\n')} }).prototype`, { target: ts.ScriptTarget.ES2022 }), { Date: FixedDate, Not, IsNull });
}
const service = methods('packages/backend/src/core/AnnouncementService.ts', ['onModuleInit', 'archiveAnnouncement']);
const producer = methods('packages/backend/src/core/QueueService.ts', ['announcementArchiveJobId', 'scheduleAnnouncementArchive']);
const processor = methods('packages/backend/src/queue/processors/ArchiveAnnouncementProcessorService.ts', ['process']);
const config = { host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55432), database: 'backend_next_test', username: 'postgres', password: 'foundation-test-only', extra: {} };
const admin = await new DataSource({ type: 'postgres', ...config }).initialize();
const name = `archive_source_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
config.database = name;
let db;
const redis = { host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_REDIS_PORT ?? 56379), prefix: name };
const queue = new Queue('system', baseQueueOptions(redis, 'system', 5000));
let worker;
const result = { upstreamCommit: pin, corpusSha256: hash(corpusBytes), sources: manifest, cases: [], restoration: [], queue: {} };
try {
	await migrateDatabase(config);
	db = await createDataSource(config).initialize();
	const repository = db.getRepository(MiAnnouncement);
	const handler = Object.assign(Object.create(service), { announcementsRepository: repository });
	const schedule = Object.assign(Object.create(producer), { systemQueue: queue });
	handler.queueService = schedule;
	for (const item of corpus.cases) {
		await repository.createQueryBuilder().delete().execute();
		if (item.row) {
			await repository.insert({ ...item.row, title: item.id, text: item.id, autoArchiveAt: item.row.autoArchiveAt ? new Date(item.row.autoArchiveAt) : null });
		}
		const outcomes = [];
		for (let i = 0; i < item.calls; i++) {
			outcomes.push(await handler.archiveAnnouncement(item.announcementId, new Date(item.deadline)));
		}
		const rows = await repository.find({ select: { id: true, isActive: true, updatedAt: true, autoArchiveAt: true }, order: { id: 'ASC' } });
		result.cases.push({ id: item.id, outcomes, rows });
	}
	await repository.createQueryBuilder().delete().execute();
	await repository.insert([
		{ id: 'due', title: 'due', text: 'due', autoArchiveAt: new Date(clock - 1) },
		{ id: 'future', title: 'future', text: 'future', autoArchiveAt: new Date(clock + 60000) },
		{ id: 'inactive', title: 'inactive', text: 'inactive', isActive: false, autoArchiveAt: new Date(clock - 1) },
		{ id: 'undated', title: 'undated', text: 'undated' },
	]);
	await handler.onModuleInit();
	await handler.onModuleInit();
	result.restoration = (await queue.getJobs(['waiting', 'delayed'])).map(job => ({ id: job.id, name: job.name, data: job.data, delay: job.opts.delay, retention: { complete: job.opts.removeOnComplete, failed: job.opts.removeOnFail }, attempts: job.opts.attempts ?? 0 })).sort((a, b) => a.id.localeCompare(b.id));
	await queue.obliterate({ force: true });
	// A real BullMQ worker runs the unchanged pinned processor method with only DI/logger assembly replaced.
	clock = Date.now();
	const date = new Date(clock - 1000);
	await repository.update('due', { isActive: true, updatedAt: null, autoArchiveAt: date });
	const logs = [];
	const originalProcessor = Object.assign(Object.create(processor), { announcementService: handler, logger: { succ: message => logs.push('archived'), debug: message => logs.push('unmatched') } });
	worker = new Worker('system', job => originalProcessor.process(job), baseWorkerOptions(redis, 'system', 5000));
	await worker.waitUntilReady();
	await schedule.scheduleAnnouncementArchive('due', date);
	const jobId = `archiveAnnouncement-due-${date.getTime()}`;
	const wait = async (state, id = jobId) => {
		for (let i = 0; i < 200; i++) {
			if (await (await queue.getJob(id)).getState() === state) return;
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		throw Error(`Did not reach ${state}`);
	};
	await wait('completed');
	const original = await queue.getJob(jobId);
	await worker.close();
	worker = undefined;
	await schedule.scheduleAnnouncementArchive('due', date);
	const replacement = await queue.getJob(jobId);
	result.queue = { originalState: 'completed', archived: !(await repository.findOneByOrFail({ id: 'due' })).isActive, completedReplaced: replacement.attemptsMade === 0 && await replacement.getState() === 'waiting', logs, originalAttempts: original.attemptsMade };
	await replacement.remove();
	await db.query('ALTER TABLE announcement RENAME TO announcement_unavailable');
	worker = new Worker('system', job => originalProcessor.process(job), baseWorkerOptions(redis, 'system', 5000));
	await worker.waitUntilReady();
	await schedule.scheduleAnnouncementArchive('due', date);
	await wait('failed');
	await worker.close();
	worker = undefined;
	await db.query('ALTER TABLE announcement_unavailable RENAME TO announcement');
	await schedule.scheduleAnnouncementArchive('due', date);
	const failedReplacement = await queue.getJob(jobId);
	result.queue.failedReplaced = failedReplacement.attemptsMade === 0 && await failedReplacement.getState() === 'waiting';
	assert.equal(result.queue.completedReplaced, true);
	assert.equal(result.queue.failedReplaced, true);
	assert.equal(result.queue.archived, true);
	const output = `${JSON.stringify(result, null, 2)}\n`;
	if (process.argv[2]) {
		writeFileSync(process.argv[2], output);
	} else {
		assert.deepEqual(JSON.parse(output), JSON.parse(readFileSync(new URL('./observations.json', import.meta.url))));
	}
	console.log(`Pinned archive source / real PostgreSQL + Redis / ${result.cases.length} cases / source processor worker: PASS`);
} finally {
	await worker?.close();
	await queue.obliterate({ force: true });
	await queue.close();
	await db?.destroy();
	await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
	await admin.destroy();
}
