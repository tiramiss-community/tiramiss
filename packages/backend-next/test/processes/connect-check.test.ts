/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { dump } from 'js-yaml';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let redis: Redis;
let directory: string;
const names = ['redis', 'redisForPubsub', 'redisForJobQueue', 'redisForTimelines', 'redisForReactions'];

beforeAll(async () => {
	database = await createTestDatabase();
	source = await new DataSource({ type: 'postgres', ...database.config.database }).initialize();
	await source.query('CREATE TABLE migrations (id integer PRIMARY KEY, name text)');
	await source.query('INSERT INTO migrations VALUES (1, \'preserved-history\')');
	await source.query('CREATE TABLE business_record (id integer PRIMARY KEY, payload text)');
	await source.query('INSERT INTO business_record VALUES (1, \'preserved-data\')');
	redis = new Redis(database.config.redis);
	await redis.set('sentinel', 'preserved-redis');
	directory = await mkdtemp(join(tmpdir(), 'connect-check-577-'));
});
afterAll(async () => {
	await redis?.del('sentinel');
	redis?.disconnect();
	await source?.destroy();
	await database?.close();
	if (directory) {
		await rm(directory, { recursive: true, force: true });
	}
});

function configuration() {
	const config = database.config;
	const connection = { host: config.redis.host, port: config.redis.port, prefix: config.redis.prefix, connectionName: 'check-connect-577' };
	return {
		url: 'https://example.test', port: 3000,
		db: { host: config.database.host, port: config.database.port, db: config.database.database, user: config.database.username, pass: config.database.password },
		...Object.fromEntries(names.map(name => [name, { ...connection, port: name === 'redisForJobQueue' ? Number(process.env.BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT ?? 56380) : connection.port }])),
		backendNext: { startupTimeoutMs: 500 },
	};
}

async function snapshot() {
	return {
		tables: await source.query('SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\' ORDER BY table_name'),
		migrations: await source.query('SELECT * FROM migrations ORDER BY id'),
		business: await source.query('SELECT * FROM business_record ORDER BY id'),
		redis: await redis.get('sentinel'),
	};
}

async function run(value: unknown, script = false, timeout = 7000) {
	const path = join(directory, 'config.yml');
	await writeFile(path, dump(value));
	return new Promise<{ code: number | string; stdout: string; stderr: string }>(done => {
		execFile(script ? 'pnpm' : process.execPath, script ? ['--silent', 'check:connect'] : [resolve('built/entrypoints/check-connect.js')], {
			env: { ...process.env, MISSKEY_CONFIG_YML: path }, timeout,
		}, (error, stdout, stderr) => done({ code: error ? (error.code ?? error.signal ?? 'PROCESS_FAILED') : 0, stdout, stderr }));
	});
}

async function assertPreserved(before: Awaited<ReturnType<typeof snapshot>>) {
	expect(await snapshot()).toEqual(before);
	expect(await redis.client('LIST')).not.toContain('name=check-connect-577');
	const sessions = await source.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()');
	expect(sessions).toEqual([{ count: 0 }]);
}

test('package command checks all five Redis purposes and DB without changing stored state', async () => {
	const before = await snapshot();
	const result = await run(configuration(), true);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ ready: true, checks: [{ target: 'database', ready: true }, ...names.map(target => ({ target, ready: true }))] });
	expect(result.stderr).not.toContain(database.config.database.password);
	await assertPreserved(before);
});

test('omitted optional Redis settings reuse one base connection', async () => {
	const value = configuration();
	for (const name of names.slice(1)) {
		delete value[name as keyof typeof value];
	}
	const monitor = await redis.monitor();
	const connections: string[][] = [];
	monitor.on('monitor', (_time, args: string[]) => {
		if (args[0]?.toLowerCase() === 'client' && args[1]?.toLowerCase() === 'setname' && args[2] === 'check-connect-577') {
			connections.push(args);
		}
	});
	try {
		const result = await run(value);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ ready: true, checks: [{ target: 'database', ready: true }, { target: 'redis', ready: true }] });
		expect(connections).toHaveLength(1);
	} finally {
		monitor.disconnect();
	}
});

test.each(['database', ...names].flatMap(target => ['authentication', 'refused'].map(mode => ({ target, mode }))))('fails naturally and releases every connection when $target alone fails: $mode', async ({ target, mode }) => {
	const value = configuration();
	const secret = 'check-connect-private-secret';
	if (target === 'database') {
		if (mode === 'refused') {
			value.db.port = 1;
		} else {
			value.db.pass = secret;
		}
	} else {
		Object.assign(value[target as keyof typeof value] as Record<string, unknown>, mode === 'refused' ? { port: 1 } : { pass: secret, username: 'private-invalid-user' });
	}
	const before = await snapshot();
	const result = await run(value);
	expect(result.code).toBe(1);
	const output = JSON.parse(result.stdout);
	const observed = JSON.parse(await readFile(new URL('../../../../docs/superpowers/compatibility/connect-check/source-observations.json', import.meta.url), 'utf8'));
	expect(output.ready).toBe(!observed.cases.find((row: { id: string }) => row.id === target).rejects);
	expect(output.checks.filter((row: { ready: boolean }) => !row.ready)).toEqual([{ target, ready: false }]);
	expect(result.stdout + result.stderr).not.toContain(secret);
	expect(result.stdout + result.stderr).not.toContain(database.config.database.database);
	await assertPreserved(before);
});

test('invalid configuration exits without printing configuration contents', async () => {
	const result = await run({ secret: 'private-marker' });
	expect(result).toEqual({ code: 1, stdout: '', stderr: 'Connection check initialization failed.\n' });
});

test.each([
	{ mode: 'loading', ready: false },
	{ mode: 'waiting', ready: false },
	{ mode: 'recovering', ready: true },
	{ mode: 'noperm', ready: true },
	{ mode: 'error', ready: false },
	{ mode: 'silent', ready: false },
	{ mode: 'disabled', ready: true },
	{ mode: 'auth-valid', ready: true },
	{ mode: 'auth-invalid', ready: false },
	{ mode: 'auth-password-valid', ready: true },
	{ mode: 'auth-password-invalid', ready: false },
])('bounds Redis readiness and drains every accepted connection: $mode', async ({ mode, ready }) => {
	const sockets = new Set<Socket>();
	let infos = 0;
	let authResponses = 0;
	const commands: string[] = [];
	const authenticationArguments: string[][] = [];
	const authentication = mode.startsWith('auth-');
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on('error', () => {});
		const replies = new Set<NodeJS.Timeout>();
		socket.on('close', () => {
			sockets.delete(socket);
			for (const timer of replies) {
				clearTimeout(timer);
			}
		});
		let pending = Buffer.alloc(0);
		socket.on('data', data => {
			pending = Buffer.concat([pending, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
			while (pending.length) {
				const header = pending.toString().match(/^\*(\d+)\r\n/);
				if (!header) {
					return;
				}
				let offset = header[0].length;
				const parts: string[] = [];
				for (let index = 0; index < Number(header[1]); index++) {
					const bulk = pending.subarray(offset).toString().match(/^\$(\d+)\r\n/);
					if (!bulk || pending.length < offset + bulk[0].length + Number(bulk[1]) + 2) {
						return;
					}
					offset += bulk[0].length;
					parts.push(pending.subarray(offset, offset + Number(bulk[1])).toString());
					offset += Number(bulk[1]) + 2;
				}
				pending = pending.subarray(offset);
				commands.push(parts[0].toLowerCase());
				if (authentication) {
					authenticationArguments.push(parts.slice(1));
					const timer = setTimeout(() => {
						replies.delete(timer);
						authResponses++;
						socket.write(parts[0].toLowerCase() === 'auth' && parts.at(-1) === 'fixture-password' ? '+OK\r\n' : '-WRONGPASS fixture-authentication-failed\r\n');
					}, 50);
					replies.add(timer);
					continue;
				}
				if (mode === 'silent') {
					continue;
				}
				if (parts[0].toLowerCase() !== 'info') {
					socket.write('+OK\r\n');
					continue;
				}
				infos++;
				if (mode === 'noperm' || mode === 'error') {
					socket.write(`-${mode === 'noperm' ? 'NOPERM' : 'ERR'} fixture-diagnostic\r\n`);
				} else {
					const loading = mode !== 'recovering' || infos < 2;
					const body = `loading:${loading ? 1 : 0}\r\nloading_eta_seconds:${mode === 'waiting' ? 60 : 0.01}\r\n`;
					socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
				}
			}
		});
	});
	await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
	try {
		const value = configuration();
		value.backendNext.startupTimeoutMs = 150;
		Object.assign(value, { redisForJobQueue: { host: '127.0.0.1', port: (server.address() as { port: number }).port, maxLoadingRetryTime: mode === 'waiting' ? 10000 : 10, ...(mode === 'disabled' ? { enableReadyCheck: false } : {}), ...(authentication ? { enableReadyCheck: false, disableClientInfo: true, ...(mode.startsWith('auth-password') ? {} : { username: 'fixture-user' }), pass: mode.endsWith('-valid') ? 'fixture-password' : 'fixture-invalid-password' } : {}) } });
		const before = await snapshot();
		const start = Date.now();
		const result = await run(value, false, 1500);
		expect(result.code).toBe(ready ? 0 : 1);
		expect(Date.now() - start).toBeLessThan(1200);
		expect(result.stderr).toBe('');
		expect(JSON.parse(result.stdout).checks.filter((row: { ready: boolean }) => !row.ready)).toEqual(ready ? [] : [{ target: 'redisForJobQueue', ready: false }]);
		expect(sockets.size).toBe(0);
		if (authentication) {
			expect(authResponses).toBeGreaterThan(0);
			expect(commands.length).toBeGreaterThan(0);
			expect(commands.every(command => command === 'auth')).toBe(true);
			for (const args of authenticationArguments) {
				expect(args).toEqual([...(mode.startsWith('auth-password') ? [] : ['fixture-user']), mode.endsWith('-valid') ? 'fixture-password' : 'fixture-invalid-password']);
			}
		}
		if (mode === 'disabled') {
			expect(commands).not.toContain('auth');
		}
		if (mode === 'loading') {
			expect(infos).toBeGreaterThan(1);
		} else {
			expect(infos).toBe(mode === 'disabled' || mode === 'silent' || authentication ? 0 : mode === 'recovering' ? 2 : 1);
		}
		await assertPreserved(before);
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}
		await new Promise<void>(done => server.close(() => done()));
	}
});

test('rejects a zero readiness deadline before opening connections', async () => {
	const value = configuration();
	value.backendNext.startupTimeoutMs = 0;
	const before = await snapshot();
	expect(await run(value)).toEqual({ code: 1, stdout: '', stderr: 'Connection check initialization failed.\n' });
	await assertPreserved(before);
});
