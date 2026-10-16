/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function config(extra = '') {
	const dir = await mkdtemp(join(tmpdir(), 'backend-config-'));
	dirs.push(dir);
	const file = join(dir, 'test.yml');
	await writeFile(
		file,
		dump({
			...(load(`url: https://example.test
port: 3000
db: {host: localhost, port: 5432}
redis: {host: localhost, port: 6379, pass: secret}
`) as object),
			...(load(extra) as object),
		}),
	);
	return file;
}

test('loads existing YAML names, environment fallbacks and Redis normalization', async () => {
	const value = await loadConfig({
		configFile: await config('unknownExistingFeature: true'),
		env: { DATABASE_DB: 'test', DATABASE_USER: 'tester', DATABASE_PASSWORD: '' },
	});
	expect(value.database.database).toBe('test');
	expect(value.database.password).toBe('');
	expect(value.redis.password).toBe('secret');
	expect(value.redis.keyPrefix).toBe('example.test:');
	expect(value.processes.workerCount).toBe(1);
});
test.each(['port: 0', 'backendNext: {workerCount: 0}', 'backendNext: {shutdownTimeoutMs: -1}', 'url: not-a-url'])(
	'rejects invalid runtime settings: %s',
	async (extra) => {
		await expect(
			loadConfig({ configFile: await config(extra), env: { DATABASE_DB: 'test', DATABASE_USER: 'tester' } }),
		).rejects.toThrow();
	},
);
test('accepts Unix socket without TCP port and preserves separate Redis settings', async () => {
	const file = await config(`socket: /tmp/backend.sock
port: null
redisForJobQueue: {host: queue, port: 6380, db: 3, prefix: queue-prefix}
backendNext: {workerCount: 2}`);
	const value = await loadConfig({ configFile: file, env: { DATABASE_DB: 'test', DATABASE_USER: 'tester' } });
	expect(value.http.socket).toBe('/tmp/backend.sock');
	expect(value.redisForJobQueue.host).toBe('queue');
	expect(value.redisForJobQueue.db).toBe(3);
	expect(value.redisForJobQueue.prefix).toBe('queue-prefix');
	expect(value.processes.workerCount).toBe(2);
});
