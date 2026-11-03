/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { Redis } from 'ioredis';
import { MiMeta, MiSystemAccount, MiUsedUsername, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import { createFederationKeys } from '../../src/composition/federation-keys.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createSystemAccountEnsurer } from '../../src/platform/database/system-account.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createLogger } from '../../src/platform/logger.js';
import { createUserKeypairReader } from '../../src/platform/user-keypair.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let rawRedis: Redis;
const logLines: string[] = [];
const codec = createIdCodec('aidx');

const redisKey = (userId: string) => `${database.config.redis.prefix}:kvcache:userKeypair:v2:${userId}`;

async function insertLocalUser(username: string): Promise<string> {
	const id = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiUser).insert({ id, username, usernameLower: username.toLowerCase(), host: null });
	return id;
}

async function countRows() {
	const db = resources.dataSource;
	return {
		users: await db.getRepository(MiUser).count(),
		keypairs: await db.getRepository(MiUserKeypair).count(),
		profiles: await db.getRepository(MiUserProfile).count(),
		usedUsernames: await db.getRepository(MiUsedUsername).count(),
		systemAccounts: await db.getRepository(MiSystemAccount).count(),
	};
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	await assertSchemaMatches(database.config.database);
	resources = await connectResources(database.config, createLogger('federation-keys-test', line => {
		logLines.push(line);
	}));
	// キー名をprefix込みで確かめるため、keyPrefixを付けずに接続する。
	rawRedis = new Redis({ host: database.config.redis.host, port: database.config.redis.port, db: database.config.redis.db });
});

afterAll(async () => {
	rawRedis?.disconnect();
	await resources?.close();
	await database?.close();
});

beforeEach(async () => {
	const db = resources.dataSource;
	await db.query('TRUNCATE "user", "used_username", "meta" CASCADE');
	await db.getRepository(MiMeta).insert({ id: 'x', name: 'Example Instance' });
	logLines.length = 0;
});

describe('ensureSystemAccount', () => {
	test('creates user, keypair, profile, used username and link together with upstream values', async () => {
		const ensure = createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId });

		const account = await ensure('actor');

		const db = resources.dataSource;
		expect(account.username).toBe('system.actor');
		const user = await db.getRepository(MiUser).findOneByOrFail({ id: account.id });
		expect(user).toMatchObject({
			username: 'system.actor', host: null,
			isLocked: true, isBot: true, isExplorable: false, name: 'Example Instance',
		});
		expect(await db.getRepository(MiUser).countBy({ id: account.id, usernameLower: 'system.actor' })).toBe(1);
		expect(user.token).toMatch(/^[0-9a-zA-Z]{16}$/);

		const keypair = await db.getRepository(MiUserKeypair).findOneByOrFail({ userId: account.id });
		expect(keypair.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
		expect(keypair.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		expect(createPrivateKey(keypair.privateKey).asymmetricKeyDetails?.modulusLength).toBe(2048);
		const data = Buffer.from('payload');
		expect(verify('sha256', data, keypair.publicKey, sign('sha256', data, keypair.privateKey))).toBe(true);

		const profile = await db.getRepository(MiUserProfile).findOneByOrFail({ userId: account.id });
		expect(profile.autoAcceptFollowed).toBe(false);
		expect(bcrypt.getRounds(profile.password!)).toBe(8);

		expect(await db.getRepository(MiUsedUsername).findOneBy({ username: 'system.actor' })).not.toBeNull();
		const link = await db.getRepository(MiSystemAccount).findOneByOrFail({ type: 'actor' });
		expect(link.userId).toBe(account.id);
		expect(link.id).not.toBe(account.id);
		expect(await countRows()).toEqual({ users: 1, keypairs: 1, profiles: 1, usedUsernames: 1, systemAccounts: 1 });
	});

	test('a later call, even from a fresh process cache, returns the same account without recreating it', async () => {
		const first = await createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId })('relay');

		const second = await createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId })('relay');

		expect(second).toEqual(first);
		expect(await countRows()).toEqual({ users: 1, keypairs: 1, profiles: 1, usedUsernames: 1, systemAccounts: 1 });
	});

	test('a failure in a later insert rolls back every row of the creation', async () => {
		await resources.dataSource.getRepository(MiUsedUsername).insert({ username: 'system.proxy', createdAt: new Date() });
		const ensure = createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId });

		await expect(ensure('proxy')).rejects.toMatchObject({ code: '23505' });

		expect(await countRows()).toEqual({ users: 0, keypairs: 0, profiles: 0, usedUsernames: 1, systemAccounts: 0 });
	});

	test('an existing local user with the same name is returned as is, without linking or completing it', async () => {
		const id = await insertLocalUser('System.Relay');
		const ensure = createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId });

		expect(await ensure('relay')).toEqual({ id, username: 'System.Relay' });

		expect(await countRows()).toEqual({ users: 1, keypairs: 0, profiles: 0, usedUsernames: 0, systemAccounts: 0 });
	});

	test('accounts migrated under their legacy names are found through system_account', async () => {
		const actorId = await insertLocalUser('instance.actor');
		const relayId = await insertLocalUser('relay.actor');
		// 本家migration 1740121393164 と同じく、ユーザーIDをそのまま紐付けのIDに使う。
		await resources.dataSource.getRepository(MiSystemAccount).insert([
			{ id: actorId, userId: actorId, type: 'actor' },
			{ id: relayId, userId: relayId, type: 'relay' },
		]);
		const ensure = createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId });

		expect(await ensure('actor')).toEqual({ id: actorId, username: 'instance.actor' });
		expect(await ensure('relay')).toEqual({ id: relayId, username: 'relay.actor' });
		expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: 'system.actor' })).toBe(0);
	});

	// 本家はロックを取らない。両方が作成へ進むと、後からcommitする側はuserの一意制約違反で失敗し、その例外が呼び出し元に届く。
	test('when two processes create the same account at once, one succeeds and the other gets the unique violation', async () => {
		const blocker = resources.dataSource.createQueryRunner();
		await blocker.connect();
		await blocker.startTransaction();
		// system_accountへの追加だけを止め、両方が「未作成」を確認して作成に進んだ状態を作る。
		await blocker.query('LOCK TABLE "system_account" IN EXCLUSIVE MODE');

		const outcomes = Promise.allSettled([
			createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId })('actor'),
			createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId })('actor'),
		]);
		await vi.waitFor(async () => {
			const [{ count }] = await resources.dataSource.query(
				`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
			);
			expect(count).toBe(2);
		}, { timeout: 15000, interval: 50 });
		await blocker.rollbackTransaction();
		await blocker.release();

		const settled = await outcomes;
		const fulfilled = settled.filter(result => result.status === 'fulfilled');
		const rejected = settled.filter(result => result.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toMatchObject({ code: '23505' });
		expect(await countRows()).toEqual({ users: 1, keypairs: 1, profiles: 1, usedUsernames: 1, systemAccounts: 1 });
	});

	test('the account is cached in the process for 10 minutes', async () => {
		let now = Date.now();
		const ensure = createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId, clock: () => now });
		const first = await ensure('actor');
		const otherId = await insertLocalUser('other.actor');
		await resources.dataSource.getRepository(MiSystemAccount).update({ type: 'actor' }, { userId: otherId });

		now += 10 * 60 * 1000;
		expect(await ensure('actor')).toEqual(first);

		now += 1;
		expect(await ensure('actor')).toEqual({ id: otherId, username: 'other.actor' });
	});
});

describe('readUserKeypair', () => {
	async function insertKeypair(publicKey: string, privateKey: string): Promise<string> {
		const userId = await insertLocalUser(`keyed_${codec.newId(Date.now()).toLowerCase()}`);
		await resources.dataSource.getRepository(MiUserKeypair).insert({ userId, publicKey, privateKey });
		return userId;
	}

	test('caches the row in Redis under the upstream key for 24 hours as the upstream JSON', async () => {
		const pair = await generateRsaKeyPair();
		const userId = await insertKeypair(pair.publicKeyPem, pair.privateKeyPem);
		const read = createUserKeypairReader({ manager: resources.dataSource.manager, redis: resources.redis, logger: resources.logger });

		expect(await read(userId)).toEqual(pair);

		// 本家のtoRedisConverterはTypeORMが読んだMiUserKeypairをそのままJSON化する。
		const entity = await resources.dataSource.getRepository(MiUserKeypair).findOneByOrFail({ userId });
		expect(await rawRedis.get(redisKey(userId))).toBe(JSON.stringify(entity));
		const ttl = await rawRedis.ttl(redisKey(userId));
		expect(ttl).toBeGreaterThan(86400 - 10);
		expect(ttl).toBeLessThanOrEqual(86400);
	});

	test('a value left in Redis is used before the database, then kept in memory for 1 hour', async () => {
		const stored = await generateRsaKeyPair();
		const cached = await generateRsaKeyPair();
		const userId = await insertKeypair(stored.publicKeyPem, stored.privateKeyPem);
		await rawRedis.set(redisKey(userId), JSON.stringify({ userId, publicKey: cached.publicKeyPem, privateKey: cached.privateKeyPem }), 'EX', 60);
		let now = Date.now();
		const read = createUserKeypairReader({ manager: resources.dataSource.manager, redis: resources.redis, logger: resources.logger, clock: () => now });

		expect(await read(userId)).toEqual(cached);

		await rawRedis.del(redisKey(userId));
		now += 60 * 60 * 1000;
		expect(await read(userId)).toEqual(cached);

		now += 1;
		expect(await read(userId)).toEqual(stored);
	});

	test('a missing row fails without being cached, so a row added later is found', async () => {
		const userId = await insertLocalUser(`keyless_${codec.newId(Date.now()).toLowerCase()}`);
		const read = createUserKeypairReader({ manager: resources.dataSource.manager, redis: resources.redis, logger: resources.logger });

		await expect(read(userId)).rejects.toMatchObject({ code: 'USER_KEYPAIR_NOT_FOUND' });
		expect(await rawRedis.exists(redisKey(userId))).toBe(0);

		const pair = await generateRsaKeyPair();
		await resources.dataSource.getRepository(MiUserKeypair).insert({ userId, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
		expect(await read(userId)).toEqual(pair);
	});

	describe('a legacy PKCS#1 private key', () => {
		const legacy = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
		});
		const pkcs8 = createPrivateKey(legacy.privateKey).export({ type: 'pkcs8', format: 'pem' }) as string;

		test('is returned and cached as PKCS#8, and the row is rewritten in the background', async () => {
			const userId = await insertKeypair(legacy.publicKey, legacy.privateKey);
			const read = createUserKeypairReader({ manager: resources.dataSource.manager, redis: resources.redis, logger: resources.logger });

			expect(await read(userId)).toEqual({ publicKeyPem: legacy.publicKey, privateKeyPem: pkcs8 });

			expect(JSON.parse((await rawRedis.get(redisKey(userId)))!)).toEqual({ userId, publicKey: legacy.publicKey, privateKey: pkcs8 });
			await vi.waitFor(async () => {
				expect((await resources.dataSource.getRepository(MiUserKeypair).findOneByOrFail({ userId })).privateKey).toBe(pkcs8);
			});
		});

		test('a failed rewrite is logged without key material and does not fail the read', async () => {
			const userId = await insertKeypair(legacy.publicKey, legacy.privateKey);
			const db = resources.dataSource;
			// 障害注入: user_keypairの更新だけを失敗させる。
			await db.query(`CREATE FUNCTION reject_keypair_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rejected'; END $$`);
			await db.query('CREATE TRIGGER reject_keypair_update BEFORE UPDATE ON "user_keypair" FOR EACH ROW EXECUTE FUNCTION reject_keypair_update()');
			try {
				const read = createUserKeypairReader({ manager: db.manager, redis: resources.redis, logger: resources.logger });

				expect(await read(userId)).toEqual({ publicKeyPem: legacy.publicKey, privateKeyPem: pkcs8 });

				await vi.waitFor(() => {
					expect(logLines.some(line => line.includes('user-keypair.upgrade-failed'))).toBe(true);
				});
				const line = logLines.find(item => item.includes('user-keypair.upgrade-failed'))!;
				expect(JSON.parse(line)).toMatchObject({ level: 'error', userId, error: { name: 'QueryFailedError' } });
				expect(line).not.toContain('PRIVATE KEY');
				expect((await db.getRepository(MiUserKeypair).findOneByOrFail({ userId })).privateKey).toBe(legacy.privateKey);
			} finally {
				await db.query('DROP TRIGGER reject_keypair_update ON "user_keypair"');
				await db.query('DROP FUNCTION reject_keypair_update()');
			}
		});
	});
});

test('the composed functions give a system account whose key signs verifiably once published as SPKI', async () => {
	const keys = createFederationKeys(resources, database.config);

	const account = await keys.ensureSystemAccount('actor');
	const pair = await keys.readUserKeypair(account.id);

	const data = Buffer.from('(request-target): get /users/1');
	expect(verify('sha256', data, keys.toSpkiPublicKeyPem(pair.publicKeyPem), sign('sha256', data, pair.privateKeyPem))).toBe(true);
	expect(await rawRedis.exists(redisKey(account.id))).toBe(1);
});
