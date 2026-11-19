/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiMeta, MiUser, MiUserIp } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
const diagnostics: string[] = [];
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('ip-log-test', line => diagnostics.push(line)));
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: 'alice', username: 'alice', usernameLower: 'alice', token: 'alicetoken123456' },
		{ id: 'bob', username: 'bob', usernameLower: 'bob', token: 'bobtoken12345678' },
	]);
	await resources.dataSource.getRepository(MiMeta).upsert({ id: 'x', enableIpLogging: false }, ['id']);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server?.listening) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

async function call(token: string | null, ip = '203.0.113.1', path = '/api/notes', input: object = {}) {
	const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ i: token, ...input }) });
	await response.text();
	return response.status;
}

async function count() {
	return resources.dataSource.getRepository(MiUserIp).count();
}

async function enabled(value: boolean) {
	await resources.dataSource.getRepository(MiMeta).update('x', { enableIpLogging: value });
	await resources.meta.fetch(true);
}

test('normal HTTP records only authenticated users when enabled, dedupes user/IP and uses trusted request address', async () => {
	expect(await call('alicetoken123456')).toBe(200);
	expect(await count()).toBe(0);
	await enabled(true);
	expect(await call(null)).toBe(200);
	expect(await call('invalidtoken')).toBe(401);
	expect(await count()).toBe(0);
	expect(await call('alicetoken123456')).toBe(200);
	await vi.waitFor(async () => expect(await count()).toBe(1));
	await Promise.all(Array.from({ length: 4 }, () => call('alicetoken123456')));
	await call('alicetoken123456', '203.0.113.2');
	await call('bobtoken12345678');
	await vi.waitFor(async () => expect(await count()).toBe(3));
	expect(await resources.dataSource.getRepository(MiUserIp).find({ select: { userId: true, ip: true }, order: { userId: 'ASC', ip: 'ASC' } })).toEqual([
		{ userId: 'alice', ip: '203.0.113.1' }, { userId: 'alice', ip: '203.0.113.2' }, { userId: 'bob', ip: '203.0.113.1' },
	]);
});

test('common gate and legacy note/chart adapters log authenticated requests rejected by their business rules', async () => {
	await enabled(true);
	for (const [index, path] of ['/api/users/update-memo', '/api/notes/show', '/api/notes/create', '/api/notes/delete', '/api/charts/notes'].entries()) {
		expect(await call('alicetoken123456', `203.0.113.${10 + index}`, path)).toBe(400);
	}
	await vi.waitFor(async () => expect(await count()).toBe(8));
});

test('hourly history reset still honors database user/IP uniqueness without replacing createdAt', async () => {
	const repository = resources.dataSource.getRepository(MiUserIp);
	const before = await repository.findOneByOrFail({ userId: 'alice', ip: '203.0.113.1' });
	// A fresh HTTP process has the same empty histories as an hourly clear.
	const second = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	try {
		const response = await fetch(`http://127.0.0.1:${(second.address() as { port: number }).port}/api/notes`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.1' }, body: JSON.stringify({ i: 'alicetoken123456' }) });
		expect(response.status).toBe(200);
		await response.text();
	} finally {
		await closeHttp(second);
	}
	expect(await repository.findOneByOrFail({ userId: 'alice', ip: '203.0.113.1' })).toEqual(before);
});

test('asynchronous PG rejection preserves the business result, is suppressed, and emits no SQL/IP/user data', async () => {
	await resources.dataSource.query('ALTER TABLE user_ip ADD CONSTRAINT ip_log_test_failure CHECK (ip <> \'203.0.113.99\')');
	try {
		expect(await call('alicetoken123456', '203.0.113.99')).toBe(200);
		await vi.waitFor(() => expect(diagnostics.filter(line => JSON.parse(line).event === 'api.ip-log-failed')).toHaveLength(1));
		expect(await call('alicetoken123456', '203.0.113.99')).toBe(200);
		const events = diagnostics.filter(line => JSON.parse(line).event === 'api.ip-log-failed');
		expect(events).toHaveLength(1);
		expect(events[0]).not.toMatch(/203\.0\.113|alice|INSERT|parameters|query/);
	} finally {
		await resources.dataSource.query('ALTER TABLE user_ip DROP CONSTRAINT ip_log_test_failure');
	}
});

test('HTTP close drains accepted writes and migrated schema has no pending DDL', async () => {
	const blocker = resources.dataSource.createQueryRunner();
	await blocker.connect();
	await blocker.startTransaction();
	await blocker.query('LOCK TABLE user_ip IN ACCESS EXCLUSIVE MODE');
	try {
		expect(await call('bobtoken12345678', '203.0.113.100')).toBe(200);
		let closed = false;
		const closing = closeHttp(server).then(() => {
			closed = true;
		});
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(closed).toBe(false);
		await blocker.commitTransaction();
		await closing;
	} finally {
		if (blocker.isTransactionActive) {
			await blocker.rollbackTransaction();
		}
		await blocker.release();
	}
	expect(await resources.dataSource.getRepository(MiUserIp).findOneBy({ userId: 'bob', ip: '203.0.113.100' })).not.toBeNull();
	await assertSchemaMatches(database.config.database);
});
