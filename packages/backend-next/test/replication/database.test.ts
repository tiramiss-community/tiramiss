/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Queue } from 'bullmq';
import { startRemotePeer, plainActor, deferred } from '../helpers/remote-peer.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { dump } from 'js-yaml';
import { MiMeta, MiUser, MiNote, MiFollowing } from 'backend-upstream/entities';
import { DataSource, type EntityManager } from 'typeorm';
import { loadConfig } from '../../src/config/load-config.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createLogger } from '../../src/platform/logger.js';
import { readFromPrimary } from '../../src/platform/database/primary-read.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { migrationSources } from '../../src/platform/database/migration-sources.js';
import { createTransactionRunner } from '../../src/platform/database/transaction-runner.js';
import { createTestDatabase } from '../helpers/database.js';
import { createPinnedDatabaseSource } from '../helpers/pinned-database-source.js';
import type { DatabaseConfig } from '../../src/config/types.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let config: DatabaseConfig;
let observer: DataSource;

function location(manager: EntityManager) {
	return manager.createQueryBuilder().fromDummy().select('pg_is_in_recovery()', 'standby')
		.addSelect("current_setting('statement_timeout')", 'timeout').getRawOne();
}

// Wait for physical replay, rather than relying on a fixed delay after DDL or writes.
async function replay() {
	const primary = new DataSource({ type: 'postgres', ...database.config.database });
	await primary.initialize();
	try {
		const [{ lsn }] = await primary.query('SELECT pg_current_wal_flush_lsn() AS lsn');
		for (let attempt = 0; attempt < 200; attempt++) {
			const [{ caughtUp }] = await observer.query('SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS "caughtUp"', [lsn]);
			if (caughtUp) {
				return;
			}
			await setTimeout(25);
		}
		throw new Error('Standby did not replay the primary WAL');
	} finally {
		await primary.destroy();
	}
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	const replica = { ...database.config.database, port: Number(process.env.BACKEND_NEXT_TEST_REPLICA_DB_PORT ?? 55433) };
	// Observe replay through the pre-existing database until CREATE DATABASE is replayed.
	observer = await new DataSource({ type: 'postgres', ...replica, database: 'backend_next_test' }).initialize();
	await replay();
	config = { ...database.config.database, replicas: [replica], extra: { statement_timeout: 500 } };
	expect(await observer.query('SELECT pg_is_in_recovery() AS standby')).toEqual([{ standby: true }]);
});

afterAll(async () => {
	if (observer?.isInitialized) {
		await observer.destroy();
	}
	await database?.close();
});

for (const [name, create] of [['next', createDataSource], ['pinned-source', createPinnedDatabaseSource]] as const) {
	describe(name, () => {
		let source: DataSource;
		beforeAll(async () => {
			source = await create(config).initialize();
		});
		afterAll(async () => {
			if (source?.isInitialized) {
				await source.destroy();
			}
		});

		test('reads from the streaming standby and applies primary db.extra to both pools', async () => {
			expect(await location(source.manager)).toEqual({ standby: true, timeout: '500ms' });
			expect(await source.query('SELECT pg_is_in_recovery() AS standby')).toEqual([{ standby: false }]);
		});

		test('writes to the primary and reads its own writes inside the common transaction boundary', async () => {
			const runner = createTransactionRunner(source, manager => manager);
			await source.getRepository(MiMeta).upsert({ id: name, name: 'before' }, ['id']);
			await runner.run(async manager => {
				expect(await location(manager)).toEqual({ standby: false, timeout: '500ms' });
				await manager.getRepository(MiMeta).update({ id: name }, { name: 'committed' });
				expect((await manager.getRepository(MiMeta).findOneByOrFail({ id: name })).name).toBe('committed');
			});
			await replay();
			expect((await source.getRepository(MiMeta).findOneByOrFail({ id: name })).name).toBe('committed');
		});

		test('rolls back failed transactions without persisting their writes', async () => {
			const id = `${name}-rollback`;
			await source.getRepository(MiMeta).upsert({ id, name: 'original' }, ['id']);
			await expect(source.transaction(async manager => {
				await manager.getRepository(MiMeta).update({ id }, { name: 'rolled-back' });
				await manager.query('SELECT pg_sleep(1)');
			})).rejects.toMatchObject({ driverError: { code: '57014' } });
			await replay();
			expect((await source.getRepository(MiMeta).findOneByOrFail({ id })).name).toBe('original');
		});

		test('rejects replica authentication failures instead of reporting a connected source', async () => {
			const failed = create({ ...config, replicas: [{ ...config.replicas![0], password: 'incorrect-test-password' }] });
			await expect(failed.initialize()).rejects.toMatchObject({ code: '28P01' });
			expect(failed.isInitialized).toBe(false);
		});

		test('lets db.extra connection fields override replica credentials as upstream does', async () => {
			const overridden = await create({ ...config, extra: { ...config.extra, port: config.port } }).initialize();
			try {
				expect(await location(overridden.manager)).toEqual({ standby: false, timeout: '500ms' });
			} finally {
				await overridden.destroy();
			}
		});

		test('retains upstream primary fallback for an enabled empty slave list', async () => {
			const empty = await create({ ...config, replicas: [] }).initialize();
			try {
				expect(await location(empty.manager)).toEqual({ standby: false, timeout: '500ms' });
			} finally {
				await empty.destroy();
			}
		});
	});
}

test('normal YAML → connectResources uses the standby while migrations stay on the primary', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'database-replication-'));
	let resources: Awaited<ReturnType<typeof connectResources>> | undefined;
	const db = config;
	const slave = config.replicas![0];
	const yamlDb = (value: typeof slave) => ({ host: value.host, port: value.port, db: value.database, user: value.username, pass: value.password });
	try {
		const configFile = join(directory, 'test.yml');
		await writeFile(configFile, dump({
			url: 'https://example.test', port: 3000,
			db: { ...yamlDb(db), extra: { ...db.extra, application_name: 'db567-normal-runtime' } }, dbReplications: true, dbSlaves: [yamlDb(slave)],
			redis: { host: database.config.redis.host, port: database.config.redis.port, prefix: database.config.redis.prefix },
		}));
		const loaded = await loadConfig({ configFile, env: {} });
		resources = await connectResources(loaded, createLogger('database-replication-test', () => {}));
		expect(await location(resources.dataSource.manager)).toEqual({ standby: true, timeout: '500ms' });
		await resources.dataSource.transaction(async manager => {
			expect(await location(manager)).toEqual({ standby: false, timeout: '500ms' });
		});
		await resources.close();
		resources = undefined;
		const primary = await new DataSource({ type: 'postgres', ...database.config.database }).initialize();
		try {
			for (const connection of [primary, observer]) {
				await expect.poll(() => connection.query("SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE application_name = 'db567-normal-runtime'"), { timeout: 5000, interval: 25 })
					.toEqual([{ sessions: 0 }]);
			}
		} finally {
			await primary.destroy();
		}
		for (const source of Object.values(migrationSources({ ...loaded.database, extra: db.extra }))) {
			await source.initialize();
			try {
				expect(await location(source.manager)).toEqual({ standby: false, timeout: '500ms' });
			} finally {
				await source.destroy();
			}
		}
	} finally {
		await resources?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test.each(['primary', 'replica'] as const)('failed %s initialization closes every already opened pool', async failure => {
	const applicationName = `db567-partial-${failure}`;
	const failed = createDataSource({ ...config,
		...(failure === 'primary' ? { password: 'incorrect-test-password' } : {}),
		replicas: failure === 'primary' ? config.replicas : [config.replicas![0], { ...config.replicas![0], password: 'incorrect-test-password' }],
		extra: { ...config.extra, idleTimeoutMillis: 0, application_name: applicationName },
	});
	try {
		await expect(failed.initialize()).rejects.toMatchObject({ code: '28P01' });
		expect(failed.isInitialized).toBe(false);
		await expect.poll(() => observer.query('SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE application_name = $1', [applicationName]), { timeout: 1000, interval: 25 })
			.toEqual([{ sessions: 0 }]);
	} finally {
		// Keep the red reproduction isolated even before failed-initialization disposal exists.
		await observer.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [applicationName]);
	}
});

test.each([false, true])('normal create response and post-save delivery survive paused replay (poll: %s)', async withPoll => {
	const runtime = { ...database.config, database: config };
	const resources = await connectResources(runtime, createLogger('database-replication-post-save', () => {}));
	const codec = createIdCodec(runtime.id);
	const author = codec.newId(Date.now());
	const follower = codec.newId(Date.now());
	const token = withPoll ? 'replica-native02' : 'replica-native01';
	const inbox = 'https://replica-follower.test/inbox';
	const jobs = new Queue('deliver', { connection: { host: runtime.redis.host, port: runtime.redis.port }, prefix: `${runtime.redis.prefix}:queue:deliver` });
	try {
		await resources.dataSource.getRepository(MiMeta).deleteAll();
		await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
		await resources.dataSource.getRepository(MiUser).insert([
			{ id: author, username: `replicaAuthor${withPoll}`, usernameLower: `replicaauthor${withPoll}`, token },
			{ id: follower, username: `replicaFollower${withPoll}`, usernameLower: `replicafollower${withPoll}`, host: 'replica-follower.test', inbox, sharedInbox: inbox },
		]);
		await resources.dataSource.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: follower, followeeId: author, followerHost: 'replica-follower.test', followerInbox: inbox, followerSharedInbox: inbox });
		await replay();
		const app = createBackendHttpApp(resources, runtime);
		await observer.query('SELECT pg_wal_replay_pause()');
		await expect.poll(() => observer.query("SELECT pg_get_wal_replay_pause_state() AS state"), { timeout: 5000, interval: 25 }).toEqual([{ state: 'paused' }]);
		const response = await app.request('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, text: 'saved while replay is paused', ...(withPoll ? { poll: { choices: ['one', 'two'] } } : {}) }) });
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(200);
		expect(body.createdNote).toMatchObject({ text: 'saved while replay is paused', userId: author });
		if (withPoll) {
			expect(body.createdNote.poll.choices.map((choice: { text: string }) => choice.text)).toEqual(['one', 'two']);
		}
		const noteId = body.createdNote.id;
		// Ordinary reads retain upstream replica lag; the write and post-save paths must not depend on replay.
		expect(await resources.dataSource.getRepository(MiNote).findOneBy({ id: noteId })).toBeNull();
		await resources.notePostSave.idle();
		const queued = await jobs.getJobs(['waiting', 'delayed']);
		expect(queued.some(job => job.data.to === inbox && JSON.parse(job.data.content).object.id === `${runtime.url}/notes/${noteId}`)).toBe(true);
	} finally {
		let resumed = false;
		try {
			await observer.query('SELECT pg_wal_replay_resume()');
			resumed = true;
		} finally {
			try {
				await jobs.close();
			} finally {
				await resources.close();
			}
		}
		if (resumed) {
			await replay();
		}
	}
});

test('primary reads return each query connection after success and failure without opening a transaction', async () => {
	const source = await createDataSource({ ...config, extra: { ...config.extra, max: 1 } }, 500).initialize();
	const transactionStates: boolean[] = [];
	const restoreQueries: (() => void)[] = [];
	const originalCreate = source.createQueryRunner.bind(source);
	const create = vi.spyOn(source, 'createQueryRunner').mockImplementation(mode => {
		const runner = originalCreate(mode);
		const originalQuery = runner.query;
		const query = vi.spyOn(runner, 'query').mockImplementation((...args: Parameters<typeof runner.query>) => {
			if (args[0].includes('pg_is_in_recovery()')) {
				transactionStates.push(runner.isTransactionActive);
			}
			return Reflect.apply(originalQuery, runner, args);
		});
		restoreQueries.push(() => query.mockRestore());
		return runner;
	});
	try {
		expect(await readFromPrimary(source, manager => location(manager))).toEqual({ standby: false, timeout: '500ms' });
		const error = new Error('primary-read-fixture');
		await expect(readFromPrimary(source, async manager => {
			expect(await location(manager)).toEqual({ standby: false, timeout: '500ms' });
			throw error;
		})).rejects.toBe(error);
		expect(transactionStates.length).toBeGreaterThan(0);
		expect(transactionStates.every(active => !active)).toBe(true);
		expect(await source.query('SELECT 1 AS ready')).toEqual([{ ready: 1 }]);
	} finally {
		create.mockRestore();
		for (const restore of restoreQueries) {
			restore();
		}
		await source.destroy();
	}
});

test('primary reads release their query connection while waiting for non-DB work', async () => {
	const source = await createDataSource({ ...config, extra: { ...config.extra, max: 1 } }, 500).initialize();
	const entered = deferred();
	const resume = deferred();
	const reading = readFromPrimary(source, async manager => {
		await location(manager);
		entered.resolve();
		await resume.promise;
		return location(manager);
	});
	try {
		await Promise.race([entered.promise, reading.then(() => {
			throw new Error('Primary read finished before the wait barrier');
		})]);
		expect(await source.query('SELECT 1 AS ready')).toEqual([{ ready: 1 }]);
		expect(await location(source.manager)).toEqual({ standby: true, timeout: '500ms' });
	} finally {
		resume.resolve();
		try {
			await reading;
		} finally {
			await source.destroy();
		}
	}
});

test('newly resolved remote mention retains its stored URI and direct delivery before WAL replay', async () => {
	const peer = await startRemotePeer();
	let resources: Awaited<ReturnType<typeof connectResources>> | undefined;
	let jobs: Queue | undefined;
	const errors: unknown[] = [];
	try {
		const actor = plainActor(peer.origin, 'freshreplica');
		peer.respond(async request => request.path.startsWith('/.well-known/webfinger')
			? { type: 'application/jrd+json', body: { links: [{ rel: 'self', type: 'application/activity+json', href: actor.id }] } }
			: request.path === '/users/freshreplica' ? { body: actor } : { status: 404, body: {} });
		vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
		const runtime = { ...database.config, database: config, outboundHttp: { ...database.config.outboundHttp, proxy: peer.proxy } };
		resources = await connectResources(runtime, createLogger('database-replication-mention', () => {}));
		const codec = createIdCodec(runtime.id);
		const author = codec.newId(Date.now());
		const token = 'replica-native03';
		jobs = new Queue('deliver', { connection: { host: runtime.redis.host, port: runtime.redis.port }, prefix: `${runtime.redis.prefix}:queue:deliver` });
		await resources.dataSource.getRepository(MiMeta).deleteAll();
		await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all', signToActivityPubGet: false });
		await resources.dataSource.getRepository(MiUser).insert({ id: author, username: 'replicaMention', usernameLower: 'replicamention', token });
		await replay();
		await observer.query('SELECT pg_wal_replay_pause()');
		await expect.poll(() => observer.query("SELECT pg_get_wal_replay_pause_state() AS state"), { timeout: 5000, interval: 25 }).toEqual([{ state: 'paused' }]);
		const app = createBackendHttpApp(resources, runtime);
		const response = await app.request('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, text: `hello @freshreplica@${new URL(peer.origin).host}` }) });
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(200);
		const [stored] = await resources.dataSource.query('SELECT id, mentions, "mentionedRemoteUsers" FROM note WHERE id=$1', [body.createdNote.id]);
		expect(stored.mentions).toHaveLength(1);
		expect(JSON.parse(stored.mentionedRemoteUsers)).toContainEqual(expect.objectContaining({ uri: actor.id }));
		await resources.notePostSave.idle();
		const queued = await jobs.getJobs(['waiting', 'delayed']);
		const job = queued.find(job => job.data.to === actor.inbox && JSON.parse(job.data.content).object.id === `${runtime.url}/notes/${stored.id}`);
		expect(job).toBeDefined();
		const activity = JSON.parse(job!.data.content);
		expect([...activity.object.to, ...activity.object.cc]).toContain(actor.id);
	} finally {
		let resumed = false;
		try {
			await observer.query('SELECT pg_wal_replay_resume()');
			resumed = true;
		} catch (error) {
			errors.push(error);
		}
		try {
			const closed = await Promise.allSettled([jobs?.close(), resources?.close(), peer.close()]);
			errors.push(...closed.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
		} finally {
			vi.unstubAllEnvs();
		}
		if (resumed) {
			try {
				await replay();
			} catch (error) {
				errors.push(error);
			}
		}
	}
	// Keep an existing assertion failure; successful bodies must still report cleanup failures.
	if (errors.length > 0) {
		throw new AggregateError(errors, 'Remote mention fixture cleanup failed');
	}
});

test('primary reader keeps an explicitly selected transaction runner', async () => {
	const source = await createDataSource({ ...config, extra: { ...config.extra, max: 1 } }, 500).initialize();
	const error = new Error('transaction-fixture-rollback');
	try {
		await expect(source.transaction(async manager => {
			await manager.getRepository(MiMeta).insert({ id: 'primary-transaction', name: 'uncommitted' });
			await readFromPrimary(source, async primary => {
				const row = await primary.createQueryBuilder(MiMeta, 'meta', manager.queryRunner)
					.where('meta.id = :id', { id: 'primary-transaction' }).getOneOrFail();
				expect(row.name).toBe('uncommitted');
				expect(manager.queryRunner?.isReleased).toBe(false);
			});
			throw error;
		})).rejects.toBe(error);
	} finally {
		await source.destroy();
	}
});
