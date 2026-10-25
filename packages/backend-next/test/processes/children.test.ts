/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { MiMeta, MiNote, MiUser } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { migrateTestDatabase as migrateDatabase } from '../helpers/database.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
});
afterAll(async () => {
	await database?.close();
});
test.each(['http', 'worker'])('starts %s standalone and exits normally on SIGTERM', async (role) => {
	const config = await configuration({ ...database.config, http: { port: await freePort() } });
	const child = launch(`built/entrypoints/${role}.js`, config.path);
	try {
		await child.ready;
		child.child.kill('SIGTERM');
		expect((await child.exit).code).toBe(0);
	} finally {
		await child.close();
		await config.close();
	}
});
test('serves the default 404 over TCP only after ready', async () => {
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port } });
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		expect((await fetch(`http://127.0.0.1:${port}/api/not-implemented`)).status).toBe(404);
		child.child.kill('SIGTERM');
		expect((await child.exit).code).toBe(0);
	} finally {
		await child.close();
		await config.close();
	}
});
test('serves a Unix socket and removes it on shutdown', async () => {
	const config = await configuration(database.config);
	const socket = join(config.directory, 'http.sock');
	const local = await configuration({ ...database.config, http: { socket } });
	const child = launch('built/entrypoints/http.js', local.path);
	try {
		await child.ready;
		const status = await new Promise<number | undefined>((done, reject) => {
			const req = request({ socketPath: socket, path: '/' }, (res) => {
				res.resume();
				done(res.statusCode);
			});
			req.on('error', reject);
			req.end();
		});
		expect(status).toBe(404);
		child.child.kill('SIGTERM');
		expect((await child.exit).code).toBe(0);
	} finally {
		await child.close();
		await local.close();
		await config.close();
	}
});
test.each(['database', 'redis'])('fails startup when %s is unavailable', async (dependency) => {
	const value = {
		...database.config,
		http: { port: await freePort() },
		[dependency]: { ...database.config[dependency as 'database' | 'redis'], port: 1 },
	};
	const config = await configuration(value);
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		expect((await child.exit).code).toBe(1);
		expect(child.output()).not.toContain('process.ready');
	} finally {
		await child.close();
		await config.close();
	}
});

test.each([false, true])('waits for in-flight requests with bounded shutdown (force=%s)', async (force) => {
	const port = await freePort();
	const config = await configuration({
		...database.config,
		http: { port },
		processes: { ...database.config.processes, shutdownTimeoutMs: force ? 100 : 2000 },
	});
	const child = launch('test/fixtures/slow-http.mjs', config.path, { FIXTURE_REQUEST_MS: force ? '10000' : '100' });
	try {
		await child.ready;
		const started = new Promise<void>((done) => {
			child.child.on('message', (message: any) => {
				if (message.type === 'request-started') {
					done();
				}
			});
		});
		const response = fetch(`http://127.0.0.1:${port}/`)
			.then((res) => res.text())
			.catch(() => 'disconnected');
		await started;
		child.child.kill('SIGTERM');
		expect(await response).toBe(force ? 'disconnected' : 'completed');
		expect((await child.exit).code, child.output()).toBe(force ? 1 : 0);
	} finally {
		await child.close();
		await config.close();
	}
});

test.each([false, true])('drains disconnected handlers with bounded shutdown (force=%s)', async (force) => {
	const port = await freePort();
	const config = await configuration({
		...database.config,
		http: { port },
		processes: { ...database.config.processes, shutdownTimeoutMs: force ? 100 : 2000 },
	});
	const child = launch('test/fixtures/slow-http.mjs', config.path, { FIXTURE_REQUEST_MS: force ? '10000' : '100' });
	let req: ReturnType<typeof request> | undefined;
	try {
		await child.ready;
		req = request({ hostname: '127.0.0.1', port });
		req.on('error', () => {});
		const started = new Promise<void>((done) => {
			child.child.on('message', (message: unknown) => {
				if (message && typeof message === 'object' && 'type' in message && message.type === 'request-started') {
					done();
				}
			});
		});
		req.end();
		await started;
		req.destroy();
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(force ? 1 : 0);
		expect(
			child.messages.some(
				(message) =>
					message && typeof message === 'object' && 'type' in message && message.type === 'handler-completed',
			),
		).toBe(!force);
	} finally {
		req?.destroy();
		await child.close();
		await config.close();
	}
});

test.each([false, true])('drains accepted requests before failing on publisher loss (alreadyStopping=%s)', async alreadyStopping => {
	const { Redis } = await import('ioredis');
	const { randomUUID } = await import('node:crypto');
	const connectionName = `role-publisher-${randomUUID()}`;
	const port = await freePort();
	const config = await configuration({
		...database.config,
		redisForPubsub: { ...database.config.redisForPubsub, connectionName },
		http: { port },
		processes: { ...database.config.processes, shutdownTimeoutMs: 2000 },
	});
	const control = new Redis(database.config.redis);
	const child = launch('test/fixtures/slow-http.mjs', config.path, { FIXTURE_REQUEST_MS: '500' });
	try {
		await child.ready;
		const started = new Promise<void>(resolve => {
			child.child.on('message', (message: any) => {
				if (message.type === 'request-started') {
					resolve();
				}
			});
		});
		const response = fetch(`http://127.0.0.1:${port}/`).then(value => value.text()).catch(() => 'disconnected');
		await started;
		if (alreadyStopping) {
			child.child.kill('SIGTERM');
		}
		const clients = String(await control.client('LIST'));
		const publisher = clients.split('\n').find(line => line.includes(`name=${connectionName} `) && line.includes('flags=N '));
		expect(publisher).toBeDefined();
		await control.client('KILL', 'ID', publisher!.match(/^id=(\d+)/)![1]);
		expect(await response).toBe('completed');
		expect((await child.exit).code, child.output()).toBe(1);
	} finally {
		control.disconnect();
		await child.close();
		await config.close();
	}
});

test('normal HTTP entrypoint serves a persisted note over TCP', async () => {
	const codec = createIdCodec('aidx');
	const userId = codec.newId(Date.now() - 10000);
	const noteId = codec.newId(Date.now() - 10000);
	const source = await createDataSource(database.config.database).initialize();
	try {
		await source.getRepository(MiMeta).insert({ id: 'singleton', ugcVisibilityForVisitor: 'all' });
		await source.getRepository(MiUser).insert({ id: userId, username: 'process-note-author', usernameLower: 'process-note-author' });
		await source.getRepository(MiNote).insert({ id: noteId, userId, text: 'persisted note', visibility: 'public' });
	} finally {
		await source.destroy();
	}
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port } });
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId }) });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: noteId, text: 'persisted note', userId });
		child.child.kill('SIGTERM');
		expect((await child.exit).code).toBe(0);
	} finally {
		await child.close();
		await config.close();
	}
});
