/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MiNote, MiPoll, MiPollVote, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createTestDatabase } from '../helpers/database.js';
import { openBusinessJobProducers, openPollEndedWorker } from '../helpers/business-jobs.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { migrationSources } from '../../src/platform/database/migration-sources.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { PostNotificationPersistence } from '../../src/platform/database/notification/persistence.js';
import { createPollEndedReader } from '../../src/platform/database/poll-ended.js';
import { createPollEndedHandler } from '../../src/composition/poll-ended-job.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { ENDED_POLL_NOTIFICATION } from '../../src/platform/job-queue/ended-poll-notification.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import type { DataSource } from 'typeorm';
import type { RedisConfig } from '../../src/config/types.js';
import type { PostNotification } from '../../src/modules/notification/public.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
const codec = createIdCodec('aidx');
const users: Record<string, string> = {};
const logs: Record<string, unknown>[] = [];
const logger = createLogger('poll-ended-test', line => logs.push(JSON.parse(line)));

const notifications = () => source.query('SELECT recipient_id, notification_type, notifier_id, note_id, target_note_id FROM backend_internal.notification ORDER BY recipient_id');

// 試験ごとに別の prefix を使い、他の試験や過去に投入したジョブを取得しない。
function jobRedis(): RedisConfig {
	const prefix = `poll-ended-${randomUUID()}`;
	return { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:` };
}

async function seedUser(name: string, host: string | null, receive: Record<string, unknown> = {}, profile = true) {
	const id = codec.newId(Date.now() - 100000);
	users[name] = id;
	await source.getRepository(MiUser).insert({ id, username: name, usernameLower: name, host });
	if (profile) {
		await source.getRepository(MiUserProfile).insert({ userId: id, userHost: host, notificationRecieveConfig: receive as never });
	}
	return id;
}

async function seedPoll(authorId: string, voterIds: string[]) {
	const noteId = codec.newId(Date.now());
	await source.getRepository(MiNote).insert({ id: noteId, userId: authorId, text: 'poll', visibility: 'public', hasPoll: true });
	await source.getRepository(MiPoll).insert({ noteId, choices: ['a', 'b'], votes: [0, 0], multiple: true, expiresAt: new Date(Date.now() + 1000), noteVisibility: 'public', userId: authorId, userHost: null });
	for (const [index, userId] of voterIds.entries()) {
		await source.getRepository(MiPollVote).insert({ id: codec.newId(Date.now()), noteId, userId, choice: index });
	}
	return noteId;
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await seedUser('author', null);
	await seedUser('voterA', null, { pollEnded: { type: 'all' }, mention: { type: 'never' } });
	await seedUser('voterB', null);
	await seedUser('muted', null, { pollEnded: { type: 'never' } });
	await seedUser('remote', 'remote.example');
	await seedUser('noProfile', null, {}, false);
});
beforeEach(async () => {
	logs.length = 0;
	await source.query('TRUNCATE backend_internal.notification');
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('pollEnded notifications have no notifier and the schema rejects notifier mismatches', async () => {
	const storage = new PostNotificationPersistence();
	const base: PostNotification = { id: 'n1', recipientId: users.author, type: 'pollEnded', notifierId: null, noteId: 'note', targetNoteId: null, createdAtMs: Date.UTC(2026, 10, 3) };
	await source.transaction(manager => storage.save(manager, base));
	expect(await notifications()).toEqual([{ recipient_id: users.author, notification_type: 'pollEnded', notifier_id: null, note_id: 'note', target_note_id: null }]);

	await expect(source.transaction(manager => storage.save(manager, { ...base, id: 'n2', notifierId: 'someone' }))).rejects.toThrow();
	await expect(source.transaction(manager => storage.save(manager, { ...base, id: 'n3', type: 'mention' }))).rejects.toThrow();
	await expect(source.transaction(manager => storage.save(manager, { ...base, id: 'n4', targetNoteId: 'target' }))).rejects.toThrow();
	expect(await notifications()).toHaveLength(1);
});

test('migration down removes pollEnded rows and restores the previous constraints, and up applies again', async () => {
	const other = await createTestDatabase();
	try {
		await migrateDatabase(other.config.database);
		const db = await createDataSource(other.config.database).initialize();
		const internal = await migrationSources(other.config.database).internal.initialize();
		try {
			await db.query(`INSERT INTO backend_internal.notification(notification_id,recipient_id,notification_type,notifier_id,note_id,created_at)
				VALUES ('kept','r','mention','author','note',now()),('dropped','r','pollEnded',NULL,'note',now())`);
			await internal.undoLastMigration();
			expect(await db.query('SELECT notification_id FROM backend_internal.notification')).toEqual([{ notification_id: 'kept' }]);
			await expect(db.query('INSERT INTO backend_internal.notification(notification_id,recipient_id,notification_type,notifier_id,note_id,created_at) VALUES (\'x\',\'r\',\'pollEnded\',\'a\',\'note\',now())')).rejects.toThrow();
			await expect(db.query('INSERT INTO backend_internal.notification(notification_id,recipient_id,notification_type,notifier_id,note_id,created_at) VALUES (\'y\',\'r\',\'mention\',NULL,\'note\',now())')).rejects.toThrow();

			await internal.runMigrations();
			await assertMigrationsApplied(other.config.database);
			await assertSchemaMatches(other.config.database);
		} finally {
			await internal.destroy();
			await db.destroy();
		}
	} finally {
		await other.close();
	}
});

test('reads local voters once per vote row, excluding remote voters', async () => {
	const noteId = await seedPoll(users.author, [users.voterA, users.remote, users.voterA, users.voterB, users.author]);
	const reader = createPollEndedReader(source.manager);
	expect((await reader.readLocalVoterIds(noteId)).sort()).toEqual([users.voterA, users.voterA, users.voterB, users.author].sort());
	expect(await reader.readNote(noteId)).toEqual({ id: noteId, userId: users.author, hasPoll: true });
	expect(await reader.readNote('missing')).toBeNull();
	expect(await reader.readRecipient(users.voterA)).toEqual({ userHost: null, receiveConfig: 'all' });
	expect(await reader.readRecipient(users.voterB)).toEqual({ userHost: null, receiveConfig: null });
	expect(await reader.readRecipient(users.remote)).toEqual({ userHost: 'remote.example', receiveConfig: null });
	await expect(reader.readRecipient(users.noProfile)).rejects.toMatchObject({ code: 'USER_PROFILE_NOT_FOUND' });
});

test('a delayed job enqueued by the producer runs in the worker and notifies the author and local voters', async () => {
	const redis = jobRedis();
	const noteId = await seedPoll(users.author, [users.voterA, users.voterA, users.remote, users.muted, users.voterB]);
	const producer = openBusinessJobProducers({ redis, connectTimeoutMs: 5000, logger, onLost: () => {} });
	await producer.ready();
	const stop = await openPollEndedWorker({
		redis, connectTimeoutMs: 5000, logger, reportFailure: () => {},
		handle: createPollEndedHandler({ dataSource: source, logger }, { id: 'aidx' }),
	});
	const inspect = new Queue(ENDED_POLL_NOTIFICATION, baseQueueOptions(redis, ENDED_POLL_NOTIFICATION, 5000));
	try {
		const enqueuedAt = Date.now();
		await producer.schedulePollEnded({ noteId, delayMs: 700 });
		expect(await inspect.getJobCounts('delayed')).toEqual({ delayed: 1 });
		expect(await notifications()).toEqual([]);

		await vi.waitFor(async () => {
			expect(await inspect.getJobCounts('completed')).toEqual({ completed: 1 });
		}, { timeout: 10000, interval: 50 });
		expect(Date.now() - enqueuedAt).toBeGreaterThanOrEqual(700);
		const [job] = await inspect.getJobs(['completed']);
		expect({ name: job.name, data: job.data, attemptsMade: job.attemptsMade }).toEqual({ name: noteId, data: { noteId }, attemptsMade: 1 });
		expect(job.opts).toMatchObject({ delay: 700, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } });
		// attempts を指定しないため、BullMQ の既定どおり 1 回だけ実行する。
		expect([undefined, 0]).toContain(job.opts.attempts);
		expect((await notifications()).map((row: { recipient_id: string }) => row.recipient_id).sort()).toEqual([users.author, users.voterA, users.voterB].sort());
		expect(await notifications()).toEqual(expect.arrayContaining([{ recipient_id: users.author, notification_type: 'pollEnded', notifier_id: null, note_id: noteId, target_note_id: null }]));
	} finally {
		await inspect.obliterate({ force: true });
		await inspect.close();
		await stop();
		await producer.close();
	}
});

test('a job whose deadline already passed runs immediately', async () => {
	const redis = jobRedis();
	const noteId = await seedPoll(users.author, []);
	const producer = openBusinessJobProducers({ redis, connectTimeoutMs: 5000, logger, onLost: () => {} });
	await producer.ready();
	const stop = await openPollEndedWorker({
		redis, connectTimeoutMs: 5000, logger, reportFailure: () => {},
		handle: createPollEndedHandler({ dataSource: source, logger }, { id: 'aidx' }),
	});
	try {
		await producer.schedulePollEnded({ noteId, delayMs: -1000 });
		await vi.waitFor(async () => {
			expect(await notifications()).toHaveLength(1);
		}, { timeout: 5000, interval: 50 });
	} finally {
		await stop();
		await producer.close();
	}
});

test('a failing job is attempted once, logged, and kept as failed', async () => {
	const redis = jobRedis();
	const producer = openBusinessJobProducers({ redis, connectTimeoutMs: 5000, logger, onLost: () => {} });
	await producer.ready();
	let attempts = 0;
	const stop = await openPollEndedWorker({
		redis, connectTimeoutMs: 5000, logger, reportFailure: () => {},
		handle: async () => {
			attempts++;
			throw new Error('handler failed');
		},
	});
	const inspect = new Queue(ENDED_POLL_NOTIFICATION, baseQueueOptions(redis, ENDED_POLL_NOTIFICATION, 5000));
	try {
		await producer.schedulePollEnded({ noteId: 'note', delayMs: 0 });
		await vi.waitFor(async () => {
			expect(await inspect.getJobCounts('failed')).toEqual({ failed: 1 });
		}, { timeout: 5000, interval: 50 });
		// 再試行の遅延を待たずに済むよう、失敗後に少し待って再実行がないことを確かめる。
		await new Promise(resolve => setTimeout(resolve, 300));
		const [job] = await inspect.getJobs(['failed']);
		expect({ attemptsMade: job.attemptsMade, failedReason: job.failedReason }).toEqual({ attemptsMade: 1, failedReason: 'handler failed' });
		expect(attempts).toBe(1);
		expect(await inspect.getJobCounts('wait', 'delayed', 'active')).toEqual({ wait: 0, delayed: 0, active: 0 });
		expect(logs.filter(line => line.event === 'job.failed')).toEqual([expect.objectContaining({ queue: ENDED_POLL_NOTIFICATION, jobName: 'note', attemptsMade: 0 })]);
	} finally {
		await inspect.obliterate({ force: true });
		await inspect.close();
		await stop();
		await producer.close();
	}
});

test('a malformed payload fails the job instead of completing it', async () => {
	const redis = jobRedis();
	let handled = false;
	const stop = await openPollEndedWorker({
		redis, connectTimeoutMs: 5000, logger, reportFailure: () => {},
		handle: async () => {
			handled = true;
		},
	});
	const inspect = new Queue(ENDED_POLL_NOTIFICATION, baseQueueOptions(redis, ENDED_POLL_NOTIFICATION, 5000));
	try {
		await inspect.add('note', { note: 'missing' });
		await vi.waitFor(async () => {
			expect(await inspect.getJobCounts('failed')).toEqual({ failed: 1 });
		}, { timeout: 5000, interval: 50 });
		expect(handled).toBe(false);
		expect(logs.filter(line => line.event === 'job.failed')).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_JOB_PAYLOAD' }) })]);
	} finally {
		await inspect.obliterate({ force: true });
		await inspect.close();
		await stop();
	}
});

test('a recipient whose save fails is logged without failing the job or skipping others', async () => {
	const noteId = await seedPoll(users.author, [users.voterA, users.voterB]);
	const handle = createPollEndedHandler({ dataSource: source, logger }, { id: 'aidx' });
	// voterA への保存だけを DB の制約で失敗させる。
	await source.query(`ALTER TABLE backend_internal.notification ADD CONSTRAINT probe_reject CHECK (recipient_id <> '${users.voterA}')`);
	try {
		await handle({ noteId });
	} finally {
		await source.query('ALTER TABLE backend_internal.notification DROP CONSTRAINT probe_reject');
	}
	expect((await notifications()).map((row: { recipient_id: string }) => row.recipient_id).sort()).toEqual([users.author, users.voterB].sort());
	expect(logs.filter(line => line.event === 'poll-ended.notification-failed')).toEqual([expect.objectContaining({ noteId, recipientId: users.voterA })]);
});

test('a missing recipient profile fails the job after earlier recipients were notified', async () => {
	const noteId = await seedPoll(users.author, [users.noProfile]);
	const handle = createPollEndedHandler({ dataSource: source, logger }, { id: 'aidx' });
	await expect(handle({ noteId })).rejects.toMatchObject({ code: 'USER_PROFILE_NOT_FOUND' });
	expect((await notifications()).map((row: { recipient_id: string }) => row.recipient_id)).toEqual([users.author]);
});

// 取得ループの待ち受け接続は BullMQ が prefix から名前を付ける。主接続には設定の connectionName が残る。
test.each([
	['main', (redis: RedisConfig, line: string) => line.includes(`name=${redis.connectionName} `)],
	['blocking', (redis: RedisConfig, line: string) => line.includes(`name=${redis.prefix}:`) && line.includes('cmd=bzpopmin')],
])('losing the worker %s connection is reported as a failure', async (_kind, match) => {
	const redis = { ...jobRedis(), connectionName: `worker-${randomUUID()}` };
	const control = new Redis(database.config.redis);
	const failures: Error[] = [];
	const stop = await openPollEndedWorker({
		redis, connectTimeoutMs: 5000, logger, reportFailure: error => failures.push(error),
		handle: async () => {},
	});
	try {
		// 取得ループが待ち受けに入るまで待つ。
		let target: string | undefined;
		await vi.waitFor(async () => {
			const lines = String(await control.client('LIST')).split('\n');
			expect(lines.some(line => line.includes(`name=${redis.prefix}:`) && line.includes('cmd=bzpopmin'))).toBe(true);
			target = lines.find(line => match(redis, line));
			expect(target).toBeDefined();
		}, { timeout: 5000, interval: 50 });
		await control.client('KILL', 'ID', target!.match(/^id=(\d+)/)![1]);
		await vi.waitFor(() => {
			expect(failures.map(error => (error as { code?: string }).code)).toContain('JOB_QUEUE_REDIS_ENDED');
		}, { timeout: 5000, interval: 50 });
		const reported = failures.length;
		await stop();
		// 停止に伴う残りの接続の終了は報告しない。
		expect(failures).toHaveLength(reported);
	} finally {
		await stop();
		control.disconnect();
	}
});

test('losing the producer connection is reported, and a normal close is not', async () => {
	const redis = { ...jobRedis(), connectionName: `producer-${randomUUID()}` };
	const control = new Redis(database.config.redis);
	let lost = 0;
	const producer = openBusinessJobProducers({ redis, connectTimeoutMs: 5000, logger, onLost: () => lost++ });
	try {
		await producer.ready();
		const line = String(await control.client('LIST')).split('\n').find(entry => entry.includes(`name=${redis.connectionName} `));
		expect(line).toBeDefined();
		await control.client('KILL', 'ID', line!.match(/^id=(\d+)/)![1]);
		await vi.waitFor(() => {
			expect(lost).toBe(1);
		}, { timeout: 5000, interval: 50 });
	} finally {
		await producer.close();
		control.disconnect();
	}

	const healthy = openBusinessJobProducers({ redis: jobRedis(), connectTimeoutMs: 5000, logger, onLost: () => lost++ });
	await healthy.ready();
	await healthy.close();
	expect(lost).toBe(1);
});
