/*
	* SPDX-FileCopyrightText: syuilo and misskey-project
	* SPDX-License-Identifier: AGPL-3.0-only
	*/
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiAccessToken, MiUser, MiFollowing, MiFollowRequest, MiBlocking, MiMuting, MiRenoteMuting } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { createUserRelationStore } from '../../src/platform/database/user-relation.js';
import { userRelationsFromMaterials } from '../../src/modules/user-relation/public.js';
import corpus from '../../../../docs/superpowers/compatibility/user-relation/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/user-relation/observations.json' with { type: 'json' };
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('user-relation-test', () => {}));
	await resources.dataSource.getRepository(MiUser).insert(['alice', 'bob', 'carol', 'empty'].map(id => ({ id, username: id, usernameLower: id, token: `${id}token1234567`.padEnd(16, '0').slice(0, 16) })));
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: 'scoped', userId: 'alice', token: 'accountreadaccesstoken', hash: 'accountreadaccesstoken', permission: ['read:account'] },
		{ id: 'denied', userId: 'alice', token: 'accountwriteaccesstoken', hash: 'accountwriteaccesstoken', permission: ['write:account'] },
	]);
	await resources.dataSource.getRepository(MiFollowing).insert([
		{ id: 'ab', followerId: 'alice', followeeId: 'bob', withReplies: true, notify: 'normal', followerHost: 'remote.test', followerInbox: 'https://remote.test/inbox', followerSharedInbox: 'https://remote.test/shared', isFollowerHibernated: true },
		{ id: 'ca', followerId: 'carol', followeeId: 'alice' },
	]);
	await resources.dataSource.getRepository(MiFollowRequest).insert([{ id: 'ac', followerId: 'alice', followeeId: 'carol' }, { id: 'ba', followerId: 'bob', followeeId: 'alice' }]);
	await resources.dataSource.getRepository(MiBlocking).insert([{ id: 'ab', blockerId: 'alice', blockeeId: 'bob' }, { id: 'ca', blockerId: 'carol', blockeeId: 'alice' }]);
	await resources.dataSource.getRepository(MiMuting).insert([{ id: 'ab', muterId: 'alice', muteeId: 'bob', expiresAt: new Date(0) }, { id: 'ca', muterId: 'carol', muteeId: 'alice' }]);
	await resources.dataSource.getRepository(MiRenoteMuting).insert([{ id: 'ac', muterId: 'alice', muteeId: 'carol' }, { id: 'ba', muterId: 'bob', muteeId: 'alice' }]);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

async function call(input: unknown, token: string | null = 'alicetoken123456') {
	return fetch(`${url}/api/users/relation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, ...input as object }) });
}

test('ordinary product entry returns single relation as an array with following settings and directional facts', async () => {
	const response = await call({ userId: 'bob' });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual([{ id: 'bob', following: { id: 'ab', followerId: 'alice', followeeId: 'bob', withReplies: true, notify: 'normal', isFollowerHibernated: true, followerHost: 'remote.test', followerInbox: 'https://remote.test/inbox', followerSharedInbox: 'https://remote.test/shared', followeeHost: null, followeeInbox: null, followeeSharedInbox: null }, isFollowing: true, isFollowed: false, hasPendingFollowRequestFromYou: false, hasPendingFollowRequestToYou: true, isBlocking: true, isBlocked: false, isMuted: true, isRenoteMuted: false }]);
});

for (const observation of observations.cases) {
	const item = corpus.cases.find(item => item.id === observation.id)!;
	test(`normal HTTP and PostgreSQL match fixed source: ${item.id}`, async () => {
		const response = await call(item.input, `${item.viewerId}token1234567`.padEnd(16, '0').slice(0, 16));
		if (observation.error) {
			expect(response.status).toBe(400);
			expect((await response.json()).error.code).toBe(observation.error.code);
		} else {
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(observation.result);
		}
	});
}

test('literal pinned single/multiple methods run over the same PostgreSQL rows as normal HTTP', async () => {
	const output = execFileSync(process.execPath, [fileURLToPath(new URL('../../../../docs/superpowers/compatibility/user-relation/source-probe.mjs', import.meta.url)), '--pg'], {
		input: JSON.stringify({ database: database.config.database, cases: corpus.cases }), encoding: 'utf8',
	});
	expect(JSON.parse(output)).toEqual(observations.cases);
});

test('detailed-user consumers reuse fetched material after relation tables change', async () => {
	const targets = ['carol', 'bob', 'unknown', 'bob', 'alice', 'empty'];
	const materials = await createUserRelationStore(resources.dataSource.manager).reader.read('alice');
	const expected = observations.cases.find(item => item.id === 'alice-4')!;
	expect([...userRelationsFromMaterials(targets, materials).values()]).toEqual(expected.result);
	await resources.dataSource.query('ALTER TABLE following RENAME TO following_unavailable');
	try {
		expect([...userRelationsFromMaterials(targets, materials).values()]).toEqual(expected.result);
		const response = await call({ userId: 'bob' });
		expect(response.status).toBe(500);
		expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
		await expect(createUserRelationStore(resources.dataSource.manager).reader.read('alice')).rejects.toThrow();
	} finally {
		await resources.dataSource.query('ALTER TABLE following_unavailable RENAME TO following');
	}
});

test('credential, app scope, suspended viewer and malformed input preserve access ordering', async () => {
	for (const [token, code] of [[null, 'CREDENTIAL_REQUIRED'], ['invalidtoken', 'AUTHENTICATION_FAILED'], ['accountwriteaccesstoken', 'PERMISSION_DENIED']] as const) {
		const response = await call({}, token);
		expect((await response.json()).error.code).toBe(code);
	}
	const scoped = await call({ userId: 'bob' }, 'accountreadaccesstoken');
	expect(scoped.status).toBe(200);
	expect(await scoped.json()).toEqual(observations.cases[0].result);
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: true });
	try {
		const response = await call({}, 'accountwriteaccesstoken');
		expect((await response.json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
	} finally {
		await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: false });
	}
});

test('relation reads preserve all stored rows and do not expire saved mutes', async () => {
	for (const entity of [MiFollowing, MiFollowRequest, MiBlocking, MiMuting, MiRenoteMuting]) {
		expect(await resources.dataSource.getRepository(entity).count()).toBe(2);
	}
	expect((await resources.dataSource.getRepository(MiMuting).findOneByOrFail({ id: 'ab' })).expiresAt).toEqual(new Date(0));
});

test('more unique targets than the PostgreSQL parameter limit retain source output without a new input cap', async () => {
	const targets = Array.from({ length: 65536 }, (_, index) => `unknown${index}`);
	const response = await call({ userId: targets });
	expect(response.status).toBe(200);
	const actual = await response.json();
	const item = { id: 'large-unique', viewerId: 'alice', input: { userId: targets } };
	const output = execFileSync(process.execPath, [fileURLToPath(new URL('../../../../docs/superpowers/compatibility/user-relation/source-probe.mjs', import.meta.url)), '--pg'], {
		input: JSON.stringify({ database: database.config.database, cases: [item] }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
	});
	expect(actual).toEqual(JSON.parse(output)[0].result);
	expect(actual).toHaveLength(targets.length);
});
