/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiAccessToken, MiApp, MiDriveFile, MiDriveFolder, MiMeta, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';
const directory = new URL('../../../../docs/superpowers/compatibility/drive-folders/', import.meta.url);
interface Folder {
	id: string;
	userId: string;
	name: string;
	parentId: string | null;
}
interface Case {
	id: string;
	operation: string;
	input: object;
	extra?: Folder[];
	files?: {
		folderId: string;
		userId?: string;
	}[];
	fail?: string;
}
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	rows: Folder[];
	actorId: string;
	newId: string;
	cases: Case[];
};
const source = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	cases: {
		id: string;
		expected: {
			result?: unknown;
			error?: {
				code?: string;
				id?: string;
				message?: string;
			};
			rows: Folder[];
			events: unknown[];
		};
	}[];
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let port: number;
let baseSubscriber: ReturnType<Awaited<ReturnType<typeof connectResources>>['redis']['duplicate']>;
const baseEvents: unknown[] = [];
let subscriber: ReturnType<Awaited<ReturnType<typeof connectResources>>['redis']['duplicate']>;
const events: unknown[] = [];
const logs: string[] = [];
const token = 'native0000000000';
const folders = () => resources.dataSource.getRepository(MiDriveFolder);

function call(operation: string, input: unknown, auth: string | null = token) {
	return fetch(`http://127.0.0.1:${port}/api/drive/folders/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }) }, body: JSON.stringify(input) });
}

async function settled() {
	await vi.waitFor(async () => {
		await resources.redis.ping();
	}, { interval: 5 });
	await new Promise(resolve => setTimeout(resolve, 15));
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.url = 'https://folders.example:3000';
	database.config.redisForPubsub = { ...database.config.redis, port: Number(process.env.BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT ?? 56380) };
	resources = await connectResources(database.config, createLogger('folders-test', line => logs.push(line)));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	await resources.dataSource.getRepository(MiUser).insert([{ id: 'alice', username: 'alice', usernameLower: 'alice', token }, { id: 'bob', username: 'bob', usernameLower: 'bob' }]);
	for (const [i, permission] of [[], ['read:drive'], ['write:drive']].entries()) {
		await resources.dataSource.getRepository(MiAccessToken).insert({ id: `scope${i}`, userId: 'alice', token: `folder-scope-${i}`, hash: `folder-hash-${i}`, permission });
	}
	await resources.dataSource.getRepository(MiApp).insert({ id: 'app', name: 'folder app', description: '', secret: 'test', permission: ['read:drive'] });
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: 'appToken', userId: 'alice', appId: 'app', token: 'folder-app-access-token', hash: 'folder-app-hash', permission: ['write:drive'] });
	subscriber = resources.redis.duplicate(database.config.redisForPubsub);
	subscriber.on('message', (_topic, value) => {
		events.push(JSON.parse(value));
	});
	await subscriber.subscribe('folders.example:3000');
	baseSubscriber = resources.redis.duplicate();
	baseSubscriber.on('message', (_topic, value) => {
		baseEvents.push(JSON.parse(value));
	});
	await baseSubscriber.subscribe('folders.example:3000');
	const env = process.env.NODE_ENV;
	process.env.NODE_ENV = 'production';
	try {
		server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	} finally {
		process.env.NODE_ENV = env;
	}
	port = (server.address() as {
		port: number;
	}).port;
});
afterAll(async () => {
	if (server?.listening) {
		await closeHttp(server);
	}
	await subscriber?.quit();
	await baseSubscriber?.quit();
	await resources?.close();
	await database?.close();
});
beforeEach(async () => {
	await resources.dataSource.query('DELETE FROM drive_file');
	await resources.dataSource.query('DELETE FROM drive_folder');
	await resources.dataSource.query('DELETE FROM role_assignment');
	await resources.dataSource.query('DELETE FROM role');
	await resources.dataSource.getRepository(MiMeta).update('singleton', { policies: {}, rootUserId: null });
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: false });
	await folders().insert(corpus.rows);
	await resources.redis.del('limit:alice:drive/folders/create');
	events.length = 0;
	baseEvents.length = 0;
});
for (const c of corpus.cases.filter(row => row.id !== 'create-max' && row.fail !== 'ancestor')) {
	test(`real HTTP/PG/Redis matches source folder ${c.id}`, async () => {
		if (c.extra) {
			await folders().insert(c.extra);
		}
		for (const [i, file] of (c.files ?? []).entries()) {
			await resources.dataSource.getRepository(MiDriveFile).insert({ id: `file${i}`, userId: file.userId ?? 'alice', folderId: file.folderId, name: 'file', md5: '0'.repeat(32), type: 'text/plain', size: 1, url: 'https://file.example/file', storedInternal: false });
		}
		const repo = folders();
		const fault = c.fail ? vi.spyOn(repo, c.fail === 'insert' ? 'insert' : c.fail as 'update' | 'delete').mockRejectedValueOnce(Error(`${c.fail} unavailable`)) : undefined;
		try {
			const response = await call(c.operation, c.input);
			const expected = source.cases.find(row => row.id === c.id)!.expected;
			const body = response.status === 204 ? undefined : await response.json() as Record<string, unknown>;
			if (expected.error) {
				expect(response.status).toBe(expected.error.code ? 400 : 500);
				expect(body).toMatchObject({ error: expected.error.code ? { code: expected.error.code, ...(expected.error.id ? { id: expected.error.id } : {}) } : { code: 'INTERNAL_ERROR' } });
			} else {
				expect(response.status).toBe(c.operation === 'delete' ? 204 : 200);
			}
			await settled();
			const actualRows = (await folders().find()).map(({ id, name, parentId, userId }) => ({ id, name, parentId, userId }));
			const created = c.operation === 'create' && !expected.error ? body as {
				id: string;
				createdAt: string;
			} : null;
			const normalize = (value: unknown): unknown => {
				if (Array.isArray(value)) {
					return value.map(normalize);
				}
				if (value && typeof value === 'object') {
					return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'createdAt' && v === created?.createdAt ? '2000-01-01T00:00:00.000Z' : normalize(v)]));
				}
				return created && value === created.id ? corpus.newId : value;
			};
			if (!expected.error && created) {
				const expectedView = expected.result as {
					createdAt: string;
				};
				const replace = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(expectedView.createdAt, '2000-01-01T00:00:00.000Z'));
				expect(normalize(body)).toEqual(replace(expected.result));
			} else if (!expected.error) {
				expect(normalize(body)).toEqual(expected.result);
			}
			expect((normalize(actualRows) as Folder[]).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...expected.rows].sort((a, b) => a.id.localeCompare(b.id)));
			const expectedEvents = expected.events.map(e => ({ channel: 'driveStream:alice', message: { type: (e as {
						type: string;
					}).type, body: (e as {
						body: unknown;
					}).body } }));
			const expectedDate = created ? (expected.result as {
				createdAt: string;
			}).createdAt : null;
			expect(normalize(events)).toEqual(expectedDate ? JSON.parse(JSON.stringify(expectedEvents).replaceAll(expectedDate, '2000-01-01T00:00:00.000Z')) : expectedEvents);
		} finally {
			fault?.mockRestore();
		}
	});
}
test('folder publication uses the configured pubsub server and leaves ordinary Redis silent', async () => {
	const response = await call('create', { name: 'split-pubsub' });
	expect(response.status).toBe(200);
	const body = await response.json();
	await vi.waitFor(() => expect(events).toContainEqual({ channel: 'driveStream:alice', message: { type: 'folderCreated', body } }));
	expect(baseEvents).toEqual([]);
});
test('the default shared Redis configuration also delivers the source drive envelope', async () => {
	const config = { ...database.config, redisForPubsub: database.config.redis };
	const defaults = await connectResources(config, createLogger('folders-default', () => { }));
	let defaultServer: Server | undefined;
	try {
		defaultServer = await listenHttp(createBackendHttpApp(defaults, config), { port: 0 });
		const defaultPort = (defaultServer.address() as {
			port: number;
		}).port;
		const response = await fetch(`http://127.0.0.1:${defaultPort}/api/drive/folders/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'default-pubsub' }) });
		expect(response.status).toBe(200);
		const body = await response.json();
		await vi.waitFor(() => expect(baseEvents).toContainEqual({ channel: 'driveStream:alice', message: { type: 'folderCreated', body } }));
		expect(events).toEqual([]);
	} finally {
		if (defaultServer) {
			await closeHttp(defaultServer);
		}
		await defaults.close();
	}
});
test('native/app/miauth permissions, suspension and credentials precede folder input', async () => {
	expect((await call('create', {}, null)).status).toBe(401);
	expect((await call('create', {}, 'wrong')).status).toBe(401);
	for (const op of ['create', 'find', 'show', 'update', 'delete']) {
		expect((await call(op, {}, 'folder-scope-0')).status).toBe(403);
	}
	expect((await call('create', {}, 'folder-scope-1')).status).toBe(403);
	expect((await call('create', {}, 'folder-app-access-token')).status).toBe(403);
	expect((await call('find', { name: 'root' }, 'folder-app-access-token')).status).toBe(200);
	expect((await call('create', {}, 'folder-scope-2')).status).toBe(200);
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: true });
	expect(await (await call('update', {})).json()).toMatchObject({ error: { code: 'YOUR_ACCOUNT_SUSPENDED' } });
});
test('create production rate uses 10/hour, preserves invalid-input consumption and returns Retry-After', async () => {
	for (let i = 0; i < 10; i++) {
		expect((await call('create', { name: 2 })).status).toBe(400);
	}
	const exceeded = await call('create', {});
	expect(exceeded.status).toBe(429);
	expect(Number(exceeded.headers.get('Retry-After'))).toBeGreaterThan(3500);
	expect(await exceeded.json()).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef', info: { remaining: 0 } } });
	expect(events).toEqual([]);
});
test.each([false, true])('rate precedes scope and input even for suspended=%s', async (suspended) => {
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: suspended });
	for (let i = 0; i < 10; i++) {
		const response = await call('create', { name: 3 }, 'folder-scope-0');
		expect(response.status).toBe(403);
		expect(await response.json()).toHaveProperty('error.code', suspended ? 'YOUR_ACCOUNT_SUSPENDED' : 'PERMISSION_DENIED');
	}
	expect((await call('create', {}, 'folder-scope-0')).status).toBe(429);
	expect(await folders().count()).toBe(corpus.rows.length);
	expect(events).toEqual([]);
});
test('Redis limiter failure precedes suspension and missing scope', async () => {
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: true });
	const fault = vi.spyOn(resources.redis, 'multi').mockImplementationOnce(() => ({ exec: (callback: (error: Error) => void) => callback(Error('Redis unavailable')) }) as never);
	try {
		expect((await call('create', {}, 'folder-scope-0')).status).toBe(500);
		expect(await folders().count()).toBe(corpus.rows.length);
		expect(events).toEqual([]);
	} finally {
		fault.mockRestore();
	}
});
test('nonproduction create does not consume Redis quota', async () => {
	const app = createBackendHttpApp(resources, database.config);
	for (let i = 0; i < 12; i++) {
		expect((await app.request('/api/drive/folders/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(200);
	}
	expect(await resources.redis.exists('limit:alice:drive/folders/create')).toBe(0);
});
test('role factor halves quota, factor zero exempts and moderator alone does not exempt', async () => {
	await resources.dataSource.getRepository(MiRole).insert({ id: 'moderator', name: 'moderator', description: '', isModerator: true, updatedAt: new Date(), lastUsedAt: new Date() });
	await resources.dataSource.query('UPDATE role SET policies=$1 WHERE id=$2', [{ rateLimitFactor: { useDefault: false, priority: 1, value: 2 } }, 'moderator']);
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: 'assignment', userId: 'alice', roleId: 'moderator' });
	for (let i = 0; i < 5; i++) {
		expect((await call('create', {})).status).toBe(200);
	}
	expect((await call('create', {})).status).toBe(429);
	await resources.dataSource.query('UPDATE role SET policies=$1 WHERE id=$2', [{ rateLimitFactor: { useDefault: false, priority: 1, value: 0 } }, 'moderator']);
	expect((await call('create', {})).status).toBe(200);
});
test('Redis limiter failure prevents a write; post-save publication failure leaves successful HTTP and row', async () => {
	const before = await folders().count();
	const failedLimit = vi.spyOn(resources.redis, 'multi').mockImplementationOnce(() => ({ exec: (callback: (error: Error) => void) => callback(Error('limiter Redis unavailable')) }) as never);
	try {
		expect((await call('create', {})).status).toBe(500);
		expect(await folders().count()).toBe(before);
	} finally {
		failedLimit.mockRestore();
	}
	const failedPublish = vi.spyOn(resources.postingStream, 'drive').mockRejectedValueOnce(Error('pubsub unavailable'));
	try {
		expect((await call('create', { name: 'published-failed' })).status).toBe(200);
		expect(await folders().countBy({ name: 'published-failed' })).toBe(1);
		await vi.waitFor(() => expect(logs.some(line => line.includes('drive-folder-publish.failed'))).toBe(true));
	} finally {
		failedPublish.mockRestore();
	}
});
test('database varchar(128) rejects schema-valid 129-character names without event', async () => {
	expect((await call('create', { name: 'x'.repeat(128) })).status).toBe(200);
	await settled();
	events.length = 0;
	expect((await call('create', { name: 'x'.repeat(129) })).status).toBe(500);
	await settled();
	expect(events).toEqual([]);
});
test('missing ancestor during read is an internal error without a partial detail result', async () => {
	const original = folders().findOneBy.bind(folders());
	const lookup = vi.spyOn(folders(), 'findOneBy').mockImplementation(async (where) => 'id' in where && where.id === corpus.rows[0].id && !('userId' in where) ? null : original(where));
	try {
		expect((await call('show', { folderId: corpus.rows[1].id })).status).toBe(500);
		expect(events).toEqual([]);
	} finally {
		lookup.mockRestore();
	}
});
test('folder endpoints preserve upstream schema and migration history', async () => {
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	const before = await resources.dataSource.query('SELECT id, timestamp, name FROM public.migrations ORDER BY id');
	await migrateDatabase(database.config.database);
	expect(await resources.dataSource.query('SELECT id, timestamp, name FROM public.migrations ORDER BY id')).toEqual(before);
});
test('HTTP success does not await publication, and close waits for publication started by an accepted request', async () => {
	let release!: () => void;
	const pending = new Promise<void>(resolve => {
		release = () => resolve();
	});
	const publish = vi.spyOn(resources.postingStream, 'drive').mockReturnValueOnce(pending);
	let accept!: () => void;
	const accepted = new Promise<void>(resolve => {
		accept = resolve;
	});
	let continueWrite!: () => void;
	const writeGate = new Promise<void>(resolve => {
		continueWrite = resolve;
	});
	const originalInsert = folders().insert.bind(folders());
	const insert = vi.spyOn(folders(), 'insert').mockImplementationOnce(async (row) => {
		accept();
		await writeGate;
		return originalInsert(row);
	});
	let closing: Promise<void> | undefined;
	try {
		const responsePending = call('create', { name: 'slow-publication' });
		await accepted;
		let closed = false;
		closing = closeHttp(server).then(() => {
			closed = true;
		});
		continueWrite();
		const response = await responsePending;
		expect(response.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(closed).toBe(false);
		release();
		await closing;
		expect(closed).toBe(true);
	} finally {
		continueWrite();
		release();
		await closing;
		insert.mockRestore();
		publish.mockRestore();
	}
});
