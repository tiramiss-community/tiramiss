/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MiAnnouncement } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createLogger } from '../../src/platform/logger.js';
import { startQueueWorkers } from '../../src/composition/queue-workers.js';
import { createTestDatabase } from '../helpers/database.js';
import { createAnnouncementArchives } from '../../src/modules/announcement/public.js';
import { createAnnouncementArchiveStore } from '../../src/platform/database/announcement-archive.js';
import { createBusinessJobDefinitions, createBusinessJobProducers } from '../../src/platform/job-queue/business-jobs.js';
import { createBusinessJobRuntime } from '../../src/platform/job-queue/runtime.js';
import corpus from '../../../../docs/superpowers/compatibility/announcement-archive/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/announcement-archive/observations.json' with { type: 'json' };

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let queue: Queue;
let control: Redis;
const logger = createLogger('archive-test', () => {});

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	control = new Redis({ host: database.config.redisForJobQueue.host, port: database.config.redisForJobQueue.port });
	queue = new Queue('system', baseQueueOptions(database.config.redisForJobQueue, 'system', 5000));
});

afterAll(async () => {
	await queue?.obliterate({ force: true });
	await queue?.close();
	await control?.quit();
	await source?.destroy();
	await database?.close();
});

test('normal resource startup restores only active dated announcements and normal worker archives them', async () => {
	const due = new Date(Date.now() - 1000);
	const future = new Date(Date.now() + 60000);
	await source.getRepository(MiAnnouncement).insert([
		{ id: 'due', title: 'Due', text: 'Due', autoArchiveAt: due },
		{ id: 'future', title: 'Future', text: 'Future', autoArchiveAt: future },
		{ id: 'inactive', title: 'Inactive', text: 'Inactive', isActive: false, autoArchiveAt: due },
		{ id: 'undated', title: 'Undated', text: 'Undated' },
	]);
	const resources = await connectResources(database.config, logger);
	let stop: (() => Promise<void>) | undefined;
	try {
		const saved = await queue.getJobs(['waiting', 'delayed']);
		expect(saved.map(job => job.data.announcementId).sort()).toEqual(['due', 'future']);
		stop = await startQueueWorkers(resources, database.config, error => {
			throw error; 
		});
		await vi.waitFor(async () => expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'due' })).toMatchObject({ isActive: false, updatedAt: expect.any(Date) }));
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'future' })).toMatchObject({ isActive: true, updatedAt: null });
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'inactive' })).toMatchObject({ isActive: false, updatedAt: null });
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'undated' })).toMatchObject({ isActive: true, updatedAt: null });
	} finally {
		await stop?.();
		await resources.close();
	}
});

test('saved old payloads, changed dates, removed dates and deleted rows complete without altering the current announcement', async () => {
	await queue.obliterate({ force: true });
	await source.getRepository(MiAnnouncement).createQueryBuilder().delete().execute();
	const due = new Date(Date.now() - 1000);
	const future = new Date(Date.now() + 60000);
	await source.getRepository(MiAnnouncement).insert([
		{ id: 'changed', title: 'Changed', text: 'Changed', autoArchiveAt: future },
		{ id: 'removeddate', title: 'Removed', text: 'Removed' },
		{ id: 'inactive', title: 'Inactive', text: 'Inactive', isActive: false, autoArchiveAt: due },
	]);
	const originals = await Promise.all(['changed', 'removeddate', 'inactive', 'deleted'].map(announcementId => queue.add('archiveAnnouncement', { announcementId, autoArchiveAt: due.getTime() }, { jobId: `old-${announcementId}` })));
	const unknown = await queue.add('unimplementedSystemJob', {}, { jobId: 'unknown' });
	const invalid = await queue.add('archiveAnnouncement', { announcementId: 'changed' }, { jobId: 'invalid' });
	const resources = await connectResources(database.config, logger);
	const stop = await startQueueWorkers(resources, database.config, error => {
		throw error; 
	});
	try {
		await vi.waitFor(async () => {
			for (const job of originals) {
				expect(await job.getState()).toBe('completed');
			}
			expect(await unknown.getState()).toBe('failed');
			expect(await invalid.getState()).toBe('failed');
		});
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'changed' })).toMatchObject({ isActive: true, autoArchiveAt: future, updatedAt: null });
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'removeddate' })).toMatchObject({ isActive: true, updatedAt: null });
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'inactive' })).toMatchObject({ isActive: false, updatedAt: null });
	} finally {
		await stop();
		await resources.close();
	}
});

test('future jobs wait, duplicates coalesce, failures can be retried and completed or failed identities can be scheduled again', async () => {
	await queue.obliterate({ force: true });
	await source.getRepository(MiAnnouncement).createQueryBuilder().delete().execute();
	const due = new Date(Date.now() + 700);
	await source.getRepository(MiAnnouncement).insert({ id: 'delayed', title: 'Delayed', text: 'Delayed', autoArchiveAt: due });
	const resources = await connectResources(database.config, logger);
	let stop: (() => Promise<void>) | undefined;
	try {
		const id = `archiveAnnouncement-delayed-${due.getTime()}`;
		const job = (await queue.getJob(id))!;
		expect(job.data).toEqual({ announcementId: 'delayed', autoArchiveAt: due.getTime() });
		expect(job.opts).toMatchObject({ removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } });
		expect([0, undefined]).toContain(job.opts.attempts);
		await resources.announcementArchives.restore();
		expect(await queue.getJobs(['delayed', 'waiting'])).toHaveLength(1);
		await source.query('ALTER TABLE announcement RENAME TO announcement_unavailable');
		stop = await startQueueWorkers(resources, database.config, error => {
			throw error; 
		});
		await vi.waitFor(async () => expect(await job.getState()).toBe('failed'), { timeout: 10000 });
		await source.query('ALTER TABLE announcement_unavailable RENAME TO announcement');
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'delayed' })).toMatchObject({ isActive: true, updatedAt: null });
		await job.retry();
		await vi.waitFor(async () => expect(await job.getState()).toBe('completed'));
		const archived = await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'delayed' });
		expect(archived).toMatchObject({ isActive: false, updatedAt: expect.any(Date) });
		expect(archived.updatedAt!.getTime()).toBeGreaterThanOrEqual(due.getTime());
		await stop();
		stop = undefined;
		await source.getRepository(MiAnnouncement).update('delayed', { isActive: true });
		await resources.announcementArchives.restore();
		expect(await (await queue.getJob(id))!.getState()).toBe('waiting');
		const again = await queue.getJob(id);
		expect(again!.attemptsMade).toBe(0);
	} finally {
		await stop?.();
		await source.query('DO $$ BEGIN IF to_regclass(\'announcement_unavailable\') IS NOT NULL THEN ALTER TABLE announcement_unavailable RENAME TO announcement; END IF; END $$');
		await resources.close();
	}
});

test('concurrent matching jobs update once and later retries preserve updatedAt', async () => {
	await queue.obliterate({ force: true });
	await source.getRepository(MiAnnouncement).createQueryBuilder().delete().execute();
	const due = new Date(Date.now() - 1000);
	await source.getRepository(MiAnnouncement).insert({ id: 'race', title: 'Race', text: 'Race', autoArchiveAt: due });
	const resources = await connectResources(database.config, logger);
	try {
		const outcomes = await Promise.all(Array.from({ length: 5 }, () => resources.announcementArchives.archive('race', due)));
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		const archived = await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'race' });
		expect(await resources.announcementArchives.archive('race', due)).toBe(false);
		expect((await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'race' })).updatedAt).toEqual(archived.updatedAt);
	} finally {
		await resources.close();
	}
});

test('enqueue rejection fails startup and a later normal start restores the reservation', async () => {
	await queue.obliterate({ force: true });
	await source.getRepository(MiAnnouncement).createQueryBuilder().delete().execute();
	const date = new Date(Date.now() + 60000);
	await source.getRepository(MiAnnouncement).insert({ id: 'enqueuefailure', title: 'Failure', text: 'Failure', autoArchiveAt: date });
	const client = control;
	await client.acl('SETUSER', 'default', '-evalsha', '-eval');
	try {
		const failed = await connectResources(database.config, logger).then(async resources => {
			await resources.close();
			return false;
		}, () => true);
		expect(failed).toBe(true);
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'enqueuefailure' })).toMatchObject({ isActive: true, updatedAt: null });
	} finally {
		await client.acl('SETUSER', 'default', '+evalsha', '+eval');
	}
	const resources = await connectResources(database.config, logger);
	try {
		expect(await queue.getJob(`archiveAnnouncement-enqueuefailure-${date.getTime()}`)).toMatchObject({ data: { announcementId: 'enqueuefailure', autoArchiveAt: date.getTime() } });
	} finally {
		await resources.close();
	}
});

for (const item of corpus.cases) {
	test(`PostgreSQL conditional update matches pinned source: ${item.id}`, async () => {
		await source.getRepository(MiAnnouncement).createQueryBuilder().delete().execute();
		if (item.row) {
			await source.getRepository(MiAnnouncement).insert({ ...item.row, title: item.id, text: item.id, autoArchiveAt: item.row.autoArchiveAt ? new Date(item.row.autoArchiveAt) : null });
		}
		const archives = createAnnouncementArchives({ ...createAnnouncementArchiveStore(source.manager), schedule: async () => {}, now: () => new Date(corpus.now) });
		const outcomes = [];
		for (let i = 0; i < item.calls; i++) {
			outcomes.push(await archives.archive(item.announcementId, new Date(item.deadline)));
		}
		const expected = observations.cases.find(row => row.id === item.id)!;
		expect(outcomes).toEqual(expected.outcomes);
		const rows = await source.getRepository(MiAnnouncement).find({ select: { id: true, isActive: true, updatedAt: true, autoArchiveAt: true }, order: { id: 'ASC' } });
		expect(JSON.parse(JSON.stringify(rows))).toEqual(expected.rows);
	});
}

test('failed saved identity is removed and re-enqueued by the next startup restoration', async () => {
	await queue.obliterate({ force: true });
	await source.getRepository(MiAnnouncement).createQueryBuilder().delete().execute();
	const date = new Date(Date.now() - 1000);
	await source.getRepository(MiAnnouncement).insert({ id: 'failedidentity', title: 'Failed', text: 'Failed', autoArchiveAt: date });
	const resources = await connectResources(database.config, logger);
	let stop: (() => Promise<void>) | undefined;
	const archive = vi.spyOn(resources.announcementArchives, 'archive').mockRejectedValueOnce(Error('temporary database failure'));
	try {
		stop = await startQueueWorkers(resources, database.config, error => {
			throw error; 
		});
		const jobId = `archiveAnnouncement-failedidentity-${date.getTime()}`;
		await vi.waitFor(async () => expect(await (await queue.getJob(jobId))!.getState()).toBe('failed'));
		await stop();
		stop = undefined;
		archive.mockRestore();
		await resources.announcementArchives.restore();
		expect(await (await queue.getJob(jobId))!.getState()).toBe('waiting');
		expect((await queue.getJob(jobId))!.attemptsMade).toBe(0);
		stop = await startQueueWorkers(resources, database.config, error => {
			throw error; 
		});
		await vi.waitFor(async () => expect(await (await queue.getJob(jobId))!.getState()).toBe('completed'));
		expect(await source.getRepository(MiAnnouncement).findOneByOrFail({ id: 'failedidentity' })).toMatchObject({ isActive: false });
	} finally {
		archive.mockRestore();
		await stop?.();
		await resources.close();
	}
});

test('restored reservation identity, delay, retention and deduplication match pinned producer observations', async () => {
	await queue.obliterate({ force: true });
	await source.getRepository(MiAnnouncement).createQueryBuilder().delete().execute();
	const now = Date.parse(corpus.now);
	await source.getRepository(MiAnnouncement).insert([
		{ id: 'due', title: 'Due', text: 'Due', autoArchiveAt: new Date(now - 1) },
		{ id: 'future', title: 'Future', text: 'Future', autoArchiveAt: new Date(now + 60000) },
		{ id: 'inactive', title: 'Inactive', text: 'Inactive', isActive: false, autoArchiveAt: new Date(now - 1) },
		{ id: 'undated', title: 'Undated', text: 'Undated' },
	]);
	const config = { redis: database.config.redisForJobQueue, connectTimeoutMs: 5000 };
	const owner = createBusinessJobRuntime({ ...config, onError: () => {} });
	const jobs = createBusinessJobProducers(owner, createBusinessJobDefinitions(config), {});
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	try {
		const archives = createAnnouncementArchives({ ...createAnnouncementArchiveStore(source.manager), schedule: jobs.scheduleAnnouncementArchive, now: () => new Date(now) });
		await archives.restore();
		await archives.restore();
		const restored = (await queue.getJobs(['waiting', 'delayed'])).map(job => ({ id: job.id, name: job.name, data: job.data, delay: job.opts.delay, retention: { complete: job.opts.removeOnComplete, failed: job.opts.removeOnFail }, attempts: job.opts.attempts ?? 0 })).sort((a, b) => a.id!.localeCompare(b.id!));
		expect(restored).toEqual(observations.restoration);
	} finally {
		clock.mockRestore();
		await owner.stop();
	}
});
