/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiAccessToken, MiUser, MiUserMemo } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { createUserMemoReader } from '../../src/platform/database/user-memo.js';
import corpus from '../../../../docs/superpowers/compatibility/user-memo/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/user-memo/observations.json' with { type: 'json' };
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('user-memo-test', () => {}));
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: 'alice', username: 'alice', usernameLower: 'alice', token: 'alicetoken123456' },
		{ id: 'bob', username: 'bob', usernameLower: 'bob', token: 'bobtoken12345678' },
		{ id: 'target', username: 'target', usernameLower: 'target' },
	]);
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: 'scoped', userId: 'alice', token: 'accountwriteaccesstoken', hash: 'accountwriteaccesstoken', permission: ['write:account'] },
		{ id: 'denied', userId: 'alice', token: 'accountreadaccesstoken', hash: 'accountreadaccesstoken', permission: ['read:account'] },
	]);
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

async function update(input: unknown, token: string | null = 'alicetoken123456') {
	return fetch(`${url}/api/users/update-memo`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ i: token, ...input as object }),
	});
}

for (const observation of observations.cases) {
	const item = corpus.cases.find(item => item.id === observation.id)!;
	if (item.fail) {
		continue;
	}
	test(`normal HTTP and PG match fixed source with viewer changes: ${item.id}`, async () => {
		const repository = resources.dataSource.getRepository(MiUserMemo);
		await repository.createQueryBuilder().delete().execute();
		if (item.rows.length) {
			await repository.insert(item.rows);
		}
		const response = await update(item.input);
		if (observation.error) {
			expect(response.status).toBe(400);
			expect((await response.json()).error).toMatchObject(observation.error);
		} else {
			expect(response.status).toBe(204);
			expect(await response.text()).toBe('');
		}
		const rows = await resources.dataSource.query('SELECT id, "userId", "targetUserId", memo FROM user_memo') as Array<{ id: string; userId: string; targetUserId: string; memo: string }>;
		for (const row of rows) {
			if (!item.rows.some(initial => initial.id === row.id)) {
				row.id = corpus.newId;
			}
		}
		expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([...observation.rows].sort((a, b) => a.id.localeCompare(b.id)));
		const reader = createUserMemoReader(resources.dataSource.manager);
		for (const read of observation.reads) {
			expect(await reader.read(read.viewerId, item.input.userId)).toBe(read.memo);
		}
	});
}

test('tokens, scope, suspension and malformed input keep memo writes private', async () => {
	const repository = resources.dataSource.getRepository(MiUserMemo);
	await repository.createQueryBuilder().delete().execute();
	for (const [token, code] of [[null, 'CREDENTIAL_REQUIRED'], ['invalidtoken', 'AUTHENTICATION_FAILED'], ['accountreadaccesstoken', 'PERMISSION_DENIED']] as const) {
		const response = await update({}, token);
		expect((await response.json()).error.code).toBe(code);
	}
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: true });
	try {
		expect((await (await update({}, 'accountreadaccesstoken')).json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
	} finally {
		await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: false });
	}
	expect(await repository.count()).toBe(0);
	expect((await update({ userId: 'target', memo: 'scoped secret' }, 'accountwriteaccesstoken')).status).toBe(204);
	expect(await createUserMemoReader(resources.dataSource.manager).read('bob', 'target')).toBeNull();
});

test('PostgreSQL length errors and unavailable memo table return errors without changing stored memos', async () => {
	const repository = resources.dataSource.getRepository(MiUserMemo);
	await repository.createQueryBuilder().delete().execute();
	expect((await update({ userId: 'target', memo: 'x'.repeat(2048) })).status).toBe(204);
	const previous = await repository.findOneByOrFail({ userId: 'alice', targetUserId: 'target' });
	const tooLong = await update({ userId: 'target', memo: 'x'.repeat(2049) });
	expect(tooLong.status).toBe(500);
	expect((await tooLong.json()).error.code).toBe('INTERNAL_ERROR');
	expect(await repository.findOneByOrFail({ id: previous.id })).toMatchObject({ memo: 'x'.repeat(2048) });
	await resources.dataSource.query('ALTER TABLE user_memo RENAME TO user_memo_unavailable');
	try {
		for (const memo of ['text', null]) {
			const response = await update({ userId: 'target', memo });
			expect(response.status).toBe(500);
			expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
		}
		const reader = createUserMemoReader(resources.dataSource.manager);
		await expect(reader.read('alice', 'target')).rejects.toThrow();
		expect(await reader.read(null, 'target')).toBeNull();
	} finally {
		await resources.dataSource.query('ALTER TABLE user_memo_unavailable RENAME TO user_memo');
	}
	expect(await repository.findOneByOrFail({ id: previous.id })).toMatchObject({ memo: 'x'.repeat(2048) });
});

test('upstream uniqueness and both foreign keys preserve author/target deletion semantics', async () => {
	const repository = resources.dataSource.getRepository(MiUserMemo);
	await repository.createQueryBuilder().delete().execute();
	await repository.insert({ id: 'unique', userId: 'alice', targetUserId: 'target', memo: 'private' });
	await expect(repository.insert({ id: 'duplicate', userId: 'alice', targetUserId: 'target', memo: 'other' })).rejects.toThrow();
	await expect(repository.insert({ id: 'invalid', userId: 'unknown', targetUserId: 'target', memo: 'other' })).rejects.toThrow();
	await expect(repository.insert({ id: 'invalid', userId: 'alice', targetUserId: 'unknown', memo: 'other' })).rejects.toThrow();
	await resources.dataSource.getRepository(MiUser).delete('target');
	expect(await repository.count()).toBe(0);
	await repository.insert({ id: 'authordelete', userId: 'alice', targetUserId: 'bob', memo: 'private' });
	await resources.dataSource.getRepository(MiUser).delete('alice');
	expect(await repository.count()).toBe(0);
});
