/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiInstance, MiMeta, MiUser, MiUserKeypair } from 'backend-upstream/entities';
import { createDeliverJobHandler } from '../../src/composition/deliver-job.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createDeliverQueue, DELIVER, startDeliverWorker } from '../../src/platform/job-queue/deliver.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { startInboxRecorder } from '../helpers/outbound-http-fakes.js';
import type { RuntimeConfig } from '../../src/config/types.js';
import type { InboxRecorder } from '../helpers/outbound-http-fakes.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let inbox: InboxRecorder;
let publicKeyPem: string;
const logs: Record<string, unknown>[] = [];
const alice = createIdCodec('aidx').newId(Date.now());

let config: RuntimeConfig;
let queue: ReturnType<typeof createDeliverQueue>;
let inspect: Queue;
let stopWorker: (() => Promise<void>) | undefined;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('deliver-queue-test', line => {
		logs.push(JSON.parse(line));
	}));
	inbox = await startInboxRecorder();

	const pair = await generateRsaKeyPair();
	publicKeyPem = pair.publicKeyPem;
	await resources.dataSource.getRepository(MiUser).insert({ id: alice, username: 'alice', usernameLower: 'alice', host: null });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: alice, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
});

afterAll(async () => {
	await inbox?.close();
	await resources?.close();
	await database?.close();
});

// 試験ごとに queue の prefix と instance の行を分け、他の試験のジョブ・停止状態を引き継がない。
beforeEach(async () => {
	const prefix = `deliver-queue-${randomUUID()}`;
	config = { ...database.config, redisForJobQueue: { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:` }, deliverJob: { deliverJobMaxAttempts: 3 } };
	await resources.dataSource.getRepository(MiInstance).clear();
	// ioredis は KEYS の pattern に keyPrefix を付けない。
	const keyPrefix = database.config.redis.keyPrefix!;
	for (const key of await resources.redis.keys(`${keyPrefix}kvcache:federatedInstance:*`)) {
		await resources.redis.del(key.slice(keyPrefix.length));
	}
	await resources.dataSource.getRepository(MiMeta).clear();
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'x', federation: 'all' });
	inbox.deliveries.length = 0;
	logs.length = 0;

	const connection = { redis: config.redisForJobQueue, connectTimeoutMs: 5000, logger: resources.logger };
	queue = createDeliverQueue({ ...connection, deliverJobMaxAttempts: config.deliverJob.deliverJobMaxAttempts, onLost: () => {} });
	await queue.ready();
	inspect = new Queue(DELIVER, baseQueueOptions(config.redisForJobQueue, DELIVER, 5000));
	const handler = createDeliverJobHandler(resources, config);
	const stop = await startDeliverWorker({
		...connection,
		config: {},
		process: handler.process,
		reportFailure: () => {},
	});
	stopWorker = async () => {
		await stop();
		await handler.idle();
	};
});

afterEach(async () => {
	await stopWorker?.();
	await queue.close();
	await inspect.obliterate({ force: true });
	await inspect.close();
});

const activity = { '@context': ['https://www.w3.org/ns/activitystreams'], id: 'http://example.test/notes/n/activity', type: 'Create', object: { content: 'あ <b>&</b>' } };

async function deliverTo(...inboxes: [string, boolean][]) {
	await queue.deliverMany({ user: { id: alice }, activity, inboxes: new Map(inboxes.map(([path, shared]) => [`${inbox.origin}${path}`, shared])) });
}

async function settled(state: 'completed' | 'failed' | 'delayed', count: number) {
	await vi.waitFor(async () => {
		expect(await inspect.getJobCountByTypes(state)).toBe(count);
	}, { timeout: 10000, interval: 50 });
	return await inspect.getJobs([state]);
}

test('each inbox receives the activity signed with the stored user key and the shared digest', async () => {
	await deliverTo(['/inbox/shared', true], ['/inbox/remote1', false]);

	const jobs = await settled('completed', 2);
	expect(jobs.map(job => job.returnvalue)).toEqual(['Success', 'Success']);
	expect(inbox.deliveries.map(d => d.path).sort()).toEqual(['/inbox/remote1', '/inbox/shared']);
	for (const delivery of inbox.deliveries) {
		expect(delivery.body).toBe(JSON.stringify(activity));
		expect(delivery.keyId).toBe(`${config.url}/users/${alice}#main-key`);
		expect(delivery.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
	}
});

test('a 5xx is retried after the httpRelatedBackoff delay and the next attempt is delivered', async () => {
	inbox.respond('/inbox/flaky', 503);
	await deliverTo(['/inbox/flaky', true]);

	const [delayed] = await settled('delayed', 1);
	expect(delayed.attemptsMade).toBe(1);
	// 1 回目の失敗の後は 1 分に 0〜20% の揺らぎを足した待ち時間。
	expect(delayed.delay).toBeGreaterThanOrEqual(60000);
	expect(delayed.delay).toBeLessThanOrEqual(72000);
	expect(logs.filter(line => line.event === 'job.failed')).toEqual([expect.objectContaining({ queue: DELIVER, to: `${inbox.origin}/inbox/flaky`, attemptsMade: 0 })]);

	inbox.respond('/inbox/flaky', 202);
	await delayed.promote();
	const [completed] = await settled('completed', 1);
	expect(completed.returnvalue).toBe('Success');
	expect(inbox.deliveries).toHaveLength(2);
});

test('a 4xx stops the job without retrying', async () => {
	inbox.respond('/inbox/missing', 404);
	await deliverTo(['/inbox/missing', false]);

	const [failed] = await settled('failed', 1);
	expect(failed.failedReason).toBe('404 Not Found');
	expect(failed.attemptsMade).toBe(1);
	expect(logs.filter(line => line.event === 'job.failed')).toEqual([expect.objectContaining({ reason: '404 Not Found', error: { name: 'UnrecoverableError' } })]);
});

test('a 410 from a shared inbox stops the job and suspends the host as gone', async () => {
	inbox.respond('/inbox/gone', 410);
	await deliverTo(['/inbox/gone', true]);

	const [failed] = await settled('failed', 1);
	expect(failed.failedReason).toBe(`${new URL(inbox.origin).host} is gone`);
	// ポート付きの host は本家と同じく DB 用の host が '' になる。
	await vi.waitFor(async () => {
		expect(await resources.dataSource.getRepository(MiInstance).findOneBy({ host: '' })).toMatchObject({ isNotResponding: true, suspensionState: 'goneSuspended' });
	});
});

test('blocked and suspended destinations complete with the upstream skip results and are not sent', async () => {
	await resources.dataSource.getRepository(MiMeta).update({ id: 'x' }, { federation: 'none' });
	await deliverTo(['/inbox/blocked', true]);
	const [blocked] = await settled('completed', 1);
	expect(blocked.returnvalue).toBe('skip (blocked)');

	// 停止ホストの一覧はプロセス内に 1 時間保たれるため、別の Worker で確かめる。
	await stopWorker!();
	await resources.dataSource.getRepository(MiMeta).update({ id: 'x' }, { federation: 'all' });
	await resources.dataSource.getRepository(MiInstance).insert({ id: 'suspended', host: '', firstRetrievedAt: new Date(), suspensionState: 'manuallySuspended' });
	const handler = createDeliverJobHandler(resources, config);
	const stop = await startDeliverWorker({ redis: config.redisForJobQueue, connectTimeoutMs: 5000, logger: resources.logger, config: {}, process: handler.process, reportFailure: () => {} });
	stopWorker = stop;
	await deliverTo(['/inbox/suspended', true]);

	await vi.waitFor(async () => {
		expect((await inspect.getJobs(['completed'])).map(job => job.returnvalue).sort()).toEqual(['skip (blocked)', 'skip (suspended)']);
	}, { timeout: 10000, interval: 50 });
	expect(inbox.deliveries).toEqual([]);
});
