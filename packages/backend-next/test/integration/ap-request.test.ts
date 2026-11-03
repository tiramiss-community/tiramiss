/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPrivateKey } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiUser, MiUserKeypair } from 'backend-upstream/entities';
import { createApRequest } from '../../src/composition/ap-request.js';
import { createFederationKeys } from '../../src/composition/federation-keys.js';
import { createOutboundHttpClient } from '../../src/composition/outbound-http.js';
import { classifyDeliveryFailure } from '../../src/modules/federation/public.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { installFakeDns, startFakeServers } from '../helpers/outbound-http-fakes.js';
import type { ClientSettings, FakeServers } from '../helpers/outbound-http-fakes.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let keys: ReturnType<typeof createFederationKeys>;
let servers: FakeServers;
let restoreDns: () => void;
const logLines: string[] = [];
const codec = createIdCodec('aidx');

async function insertUserWithKeypair(username: string, pair: { publicKey: string; privateKey: string }): Promise<string> {
	const id = codec.newId(Date.now());
	const db = resources.dataSource;
	await db.getRepository(MiUser).insert({ id, username, usernameLower: username.toLowerCase(), host: null });
	await db.getRepository(MiUserKeypair).insert({ userId: id, ...pair });
	return id;
}

// 鍵は 1 プロセスで 1 回だけ作った createFederationKeys から読み、外向き HTTP は偽サーバーの設定で作る。
function postAs(userId: string) {
	return async (settings: ClientSettings, url: string, object: unknown, digest: string | undefined) => {
		const { userAgent, ...outboundHttp } = settings;
		const http = createOutboundHttpClient({ userAgent, outboundHttp }, { checkPrivateAddress: true });
		await createApRequest({ keys, http }, database.config).signedPost({ id: userId }, url, object, digest);
	};
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('ap-request-test', line => {
		logLines.push(line);
	}));
	keys = createFederationKeys(resources, database.config);
	restoreDns = installFakeDns();
	servers = await startFakeServers();
});

afterAll(async () => {
	await servers?.close();
	restoreDns?.();
	await resources?.close();
	await database?.close();
});

beforeEach(async () => {
	await resources.dataSource.query('TRUNCATE "user" CASCADE');
	logLines.length = 0;
});

test('signs with the stored user key so the inbox verifies it with the stored public key', async () => {
	const pair = await generateRsaKeyPair();
	const userId = await insertUserWithKeypair('alice', { publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	const activity = { type: 'Create', actor: `${database.config.url}/users/${userId}` };

	const { observation, failure } = await servers.runInbox({ id: 'stored-key', url: '{public}/inbox/202', object: activity }, postAs(userId), pair.publicKeyPem);

	expect(failure).toBeNull();
	expect(observation.received).toHaveLength(1);
	const [received] = observation.received;
	expect(received.verified).toEqual({ signature: true, digest: true });
	expect(received.body).toBe(JSON.stringify(activity));
	expect(received.headers.signature).toContain(`keyId="${database.config.url}/users/${userId}#main-key"`);
	expect(logLines.join('\n')).not.toContain('PRIVATE KEY');
});

test('signs with a legacy PKCS#1 private key after upgrading it on read', async () => {
	const pair = await generateRsaKeyPair();
	const legacy = createPrivateKey(pair.privateKeyPem).export({ type: 'pkcs1', format: 'pem' }) as string;
	const userId = await insertUserWithKeypair('legacy', { publicKey: pair.publicKeyPem, privateKey: legacy });

	const { observation, failure } = await servers.runInbox({ id: 'legacy-key', url: '{public}/inbox/202', object: '{}' }, postAs(userId), pair.publicKeyPem);

	expect(failure).toBeNull();
	expect(observation.received.map(request => request.verified)).toEqual([{ signature: true, digest: true }]);
});

test('a 410 from a shared inbox stops the delivery and marks the host gone', async () => {
	const pair = await generateRsaKeyPair();
	const userId = await insertUserWithKeypair('bob', { publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	const c = { id: 'gone', url: '{public}/inbox/410', object: '{}' };

	const { observation, failure } = await servers.runInbox(c, postAs(userId), pair.publicKeyPem);

	expect(observation.received.map(request => request.verified)).toEqual([{ signature: true, digest: true }]);
	expect(classifyDeliveryFailure({ to: servers.expand(c.url), isSharedInbox: true }, failure?.error)).toEqual({
		kind: 'stop', message: `${new URL(servers.expand(c.url)).host} is gone`, hostGone: true,
	});
});

test('a user without a keypair row fails before sending and is retried with the original error', async () => {
	const id = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiUser).insert({ id, username: 'nokey', usernameLower: 'nokey', host: null });

	const { observation, failure } = await servers.runInbox({ id: 'no-key', url: '{public}/inbox/202', object: '{}' }, postAs(id), '');

	expect(observation.received).toEqual([]);
	expect(observation.error).toMatchObject({ name: 'DiagnosticError', code: 'USER_KEYPAIR_NOT_FOUND' });
	expect(classifyDeliveryFailure({ to: servers.expand('{public}/inbox/202'), isSharedInbox: false }, failure?.error)).toEqual({ kind: 'retry', error: failure?.error });
});
