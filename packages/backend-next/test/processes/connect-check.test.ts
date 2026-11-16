/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function run(value: unknown, script = false) {
	const path = join(directory, 'config.yml');
	await writeFile(path, dump(value));
	return new Promise<{ code: number | string; stdout: string; stderr: string }>(done => {
		execFile(script ? 'pnpm' : process.execPath, script ? ['--silent', 'check:connect'] : [resolve('built/entrypoints/check-connect.js')], {
			env: { ...process.env, MISSKEY_CONFIG_YML: path }, timeout: 7000,
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
