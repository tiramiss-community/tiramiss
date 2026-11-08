/*
 * SPDX-FileCopyrightText: 2026 tiramiss-community
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Source execution records producer arguments; Queue/scheduler calls are doubles.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const fixedCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const prefix = 'packages/backend/src/';
const now = 1800000000000;
const eventId = '00000000-0000-4000-8000-000000000001';

async function capture(upstream, repository = path.resolve(__dirname, '../../../..'), bindings = {}) {
	const ts = createRequire(path.join(repository, 'package.json'))('typescript');
	const sources = {};
	const texts = new Map();
	const clone = value => JSON.parse(JSON.stringify(value));
	function source(file) {
		if (!texts.has(file)) {
			const text = execFileSync('git', ['-C', upstream, 'show', `${fixedCommit}:${file}`], { encoding: 'utf8' });
			sources[file] = {
				blob: execFileSync('git', ['-C', upstream, 'rev-parse', `${fixedCommit}:${file}`], { encoding: 'utf8' }).trim(),
				sha256: crypto.createHash('sha256').update(text).digest('hex'),
			};
			texts.set(file, text);
		}
		return texts.get(file);
	}
	function tree(file) {
		return ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
	}
	function member(file, className, name) {
		const ast = tree(file);
		const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
		const found = cls.members.filter(node => node.name?.getText(ast) === name);
		assert.equal(found.length, 1, `${className}.${name}`);
		return found[0].getText(ast);
	}
	class Clock extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	}
	const noopDecorator = () => () => {};
	const stubs = {
		'@nestjs/common': { Inject: noopDecorator, Injectable: noopDecorator },
		'@/di-symbols.js': { DI: {} },
		'@/decorators.js': { bindThis: () => {} },
		'bullmq': { MetricsTime: { ONE_WEEK: 10080 } },
		'node:crypto': { randomUUID: () => eventId },
	};
	function compile(text, filename, extra = {}) {
		const module = { exports: {} };
		const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
		vm.runInNewContext(output, {
			Date: Clock, Map, Set, Promise, Math, ...extra, module, exports: module.exports,
			require: specifier => {
				assert(Object.hasOwn(stubs, specifier), `Unexpected runtime dependency ${specifier} in ${filename}`);
				return stubs[specifier];
			},
		}, { filename });
		return module.exports;
	}
	const apFile = `${prefix}core/activitypub/ApRequestService.ts`;
	const { ApRequestCreator } = compile(`export class ApRequestCreator { ${member(apFile, 'ApRequestCreator', 'createDigest')} }`, apFile, { crypto });
	stubs['@/core/activitypub/ApRequestService.js'] = { ApRequestCreator };
	const queueFile = `${prefix}core/QueueService.ts`;
	const { QueueService, QUEUE_TYPES } = compile(source(queueFile), queueFile);
	const constFile = `${prefix}queue/const.ts`;
	const { baseQueueOptions } = compile(source(constFile), constFile);
	const calls = [];
	const queues = QUEUE_TYPES.map(queue => ({
		add: (...args) => { calls.push({ queue, method: 'add', args: clone(args) }); return Promise.resolve({ id: 'double-job' }); },
		addBulk: (...args) => { calls.push({ queue, method: 'addBulk', args: clone(args) }); return Promise.resolve([]); },
		upsertJobScheduler: (...args) => { calls.push({ queue, method: 'upsertJobScheduler', args: clone(args) }); return Promise.resolve(); },
		getJobSchedulers: () => Promise.resolve([{ key: 'clean' }, { key: 'legacy-system-job' }]),
		removeJobScheduler: (...args) => { calls.push({ queue, method: 'removeJobScheduler', args: clone(args) }); return Promise.resolve(); },
		getJob: () => Promise.resolve(null),
	}));
	const config = { redisForJobQueue: bindings.queueRedis || { prefix: 'fixture', host: 'redis.example', port: 6379, db: 0, keyPrefix: 'removed:' } };
	const service = new QueueService(config, ...queues);
	await Promise.resolve();
	const schedulers = calls.filter(call => call.method === 'upsertJobScheduler').map(call => ({ id: call.args[0], repeat: call.args[1], template: call.args[2] }));
	const schedulerCleanup = calls.filter(call => call.method === 'removeJobScheduler');
	assert.equal(schedulers.length, 9);
	const fixtures = [];
	async function record(id, producer, invoke) {
		calls.length = 0;
		await invoke();
		assert.equal(calls.length, 1, id);
		const call = calls[0];
		const jobs = call.method === 'add' ? [{ name: call.args[0], data: call.args[1], opts: call.args[2] }] : call.args[0];
		fixtures.push({ id, producer, queue: call.queue, method: call.method, jobs });
	}
	const user = { id: bindings.userId || 'user' };
	const noteId = bindings.noteId || 'note';
	const activity = bindings.activity || { id: 'https://local.example/notes/n/activity', type: 'Create', object: { id: 'https://local.example/notes/n', type: 'Note', content: 'old payload' } };
	const webhook = { id: bindings.webhookId || 'hook', userId: user.id, url: bindings.webhookUrl || 'https://hook.example/path', secret: 'fixture-secret' };
	const deliverUrl = bindings.deliverUrl || 'https://remote.example/inbox';
	const sharedInboxUrl = bindings.sharedInboxUrl || 'https://shared.example/inbox';
	await record('deliver-single', 'QueueService.deliver', () => service.deliver(user, activity, deliverUrl, false));
	await record('deliver-bulk', 'QueueService.deliverMany', () => service.deliverMany(user, activity, new Map([[deliverUrl, false], [sharedInboxUrl, true]])));
	for (const type of ['note', 'reply', 'renote', 'mention', 'follow', 'unfollow', 'followed']) {
		const content = ['note', 'reply', 'renote', 'mention'].includes(type) ? { note: { id: noteId, text: 'snapshot' } } : { user: { id: 'target', username: 'old-user', host: null } };
		await record(`webhook-${type}`, 'QueueService.userWebhookDeliver', () => service.userWebhookDeliver(webhook, type, content));
	}
	await record('inbox', 'QueueService.inbox', () => service.inbox({ id: 'https://remote.example/activity', type: 'Create' }, { keyId: 'https://remote.example/key', algorithm: 'rsa-sha256' }));
	await record('system-archive', 'QueueService.scheduleAnnouncementArchive', () => service.scheduleAnnouncementArchive('announcement', new Clock(now + 5000)));
	await record('db-import', 'QueueService.createImportFollowingToDbJob', () => service.createImportFollowingToDbJob(user, ['https://remote.example/users/target'], true));
	await record('relationship-delayed', 'QueueService.createDelayedUnfollowJob', () => service.createDelayedUnfollowJob([{ from: user, to: { id: 'target' }, requestId: 'request' }], 5000));
	await record('object-storage', 'QueueService.createDeleteObjectStorageFileJob', () => service.createDeleteObjectStorageFileJob('object-key'));
	await record('system-webhook', 'QueueService.systemWebhookDeliver', () => service.systemWebhookDeliver(webhook, 'abuseReport', { id: 'report' }));

	const noteFile = `${prefix}core/NoteCreateService.ts`;
	const noteTree = tree(noteFile);
	const blocks = [];
	function visit(node) {
		if (ts.isIfStatement(node) && node.expression.getText(noteTree) === 'data.poll && data.poll.expiresAt') {
			blocks.push(node);
		}
		ts.forEachChild(node, visit);
	}
	visit(noteTree);
	assert.equal(blocks.length, 1);
	const { poll } = compile(`export function poll(data, note) { ${blocks[0].getText(noteTree)} }`, noteFile);
	await record('poll-future', 'NoteCreateService.postNoteCreated poll conditional', () => poll.call({ queueService: service }, { poll: { expiresAt: new Clock(now + 5000) } }, { id: noteId }));
	const draftFile = `${prefix}core/NoteDraftService.ts`;
	const { Schedule } = compile(`export class Schedule { ${member(draftFile, 'NoteDraftService', 'schedule')} }`, draftFile, { bindThis: () => {} });
	const schedule = Object.assign(new Schedule(), { queueService: service });
	await record('scheduled-note', 'NoteDraftService.schedule', () => schedule.schedule({ id: 'draft', isActuallyScheduled: true, scheduledAt: new Clock(now + 5000) }));

	const upstreamPackage = JSON.parse(source('packages/backend/package.json'));
	// These definitions support the inventory; their business methods are not executed.
	for (const file of ['core/QueueModule.ts', 'queue/types.ts', 'config.ts', 'models/Webhook.ts', 'core/UserWebhookService.ts']) {
		source(`${prefix}${file}`);
	}
	assert.equal(upstreamPackage.dependencies.bullmq, '6.3.11');
	assert.equal(new Set(fixtures.map(fixture => fixture.queue)).size, 10);
	return clone({
		formatVersion: 1, sourceCommit: fixedCommit, sources,
		toolchain: { typescript: ts.version, upstreamBullmq: upstreamPackage.dependencies.bullmq },
		evidence: 'Pinned complete producer methods/module and poll conditional; explicit Queue/scheduler/decorator/clock/UUID doubles. Actual source createDigest uses node:crypto. No Redis, BullMQ generation, Nest DI, full server or business worker execution.',
		doubles: { now, eventId, schedulerRows: [{ key: 'clean' }, { key: 'legacy-system-job' }] },
		queueTypes: QUEUE_TYPES,
		queueOptions: QUEUE_TYPES.map(queue => ({ queue, options: baseQueueOptions(config, queue) })),
		fixtures, schedulers, schedulerCleanup,
	});
}

module.exports = { capture, fixedCommit };
if (require.main === module) {
	const upstream = process.env.UPSTREAM_ROOT || process.argv[2];
	assert(upstream, 'Pass pinned upstream checkout, or UPSTREAM_ROOT');
	capture(upstream, process.env.REPOSITORY_ROOT).then(fixture => {
		if (process.argv.includes('--check')) {
			const expected = process.env.EXPECTED || path.join(__dirname, 'observations.json');
			assert.deepEqual(fixture, JSON.parse(fs.readFileSync(expected, 'utf8')));
			console.log(JSON.stringify({ checked: expected, fixtures: fixture.fixtures.length, queues: fixture.queueTypes.length, sources: Object.keys(fixture.sources).length }));
		} else {
			const output = process.env.OUTPUT || path.join(os.tmpdir(), 'tiramiss-queue-handoff.actual.json');
			fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
			console.log(JSON.stringify({ output, fixtures: fixture.fixtures.length }));
		}
	}).catch(error => { console.error(error); process.exitCode = 1; });
}
