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

test('loads bounded role material cache defaults and overrides', async () => {
	const env = { DATABASE_DB: 'test', DATABASE_USER: 'tester' };
	const defaults = await loadConfig({ configFile: await config('{}'), env });
	expect(defaults.roleCache).toEqual({ rolesTtlMs: 30000, assignmentsTtlMs: 30000, assignmentsMaxEntries: 10000 });
	const configured = await loadConfig({ configFile: await config('backendNext: {roleCache: {rolesTtlMs: 500, assignmentsTtlMs: 1000, assignmentsMaxEntries: 5}}'), env });
	expect(configured.roleCache).toEqual({ rolesTtlMs: 500, assignmentsTtlMs: 1000, assignmentsMaxEntries: 5 });
});

test.each(['rolesTtlMs: 0', 'assignmentsTtlMs: -1', 'assignmentsMaxEntries: 0', 'rolesTtlMs: .inf', 'assignmentsMaxEntries: 1.5'])(
	'rejects invalid material cache settings: %s', async setting => {
		await expect(loadConfig({
			configFile: await config(`backendNext: {roleCache: {${setting}}}`),
			env: { DATABASE_DB: 'test', DATABASE_USER: 'tester' },
		})).rejects.toThrow();
	},
);

test.each(['aid', 'aidx', 'meid', 'meidg', 'ulid', 'objectid', 'AIDX'])('accepts upstream id method %s', async id => {
	const value = await loadConfig({ configFile: await config(`id: ${id}`), env: { DATABASE_DB: 'test', DATABASE_USER: 'tester' } });
	expect(value.id).toBe(id.toLowerCase());
});
test('rejects unknown ID methods at startup', async () => {
	await expect(loadConfig({ configFile: await config('id: unknown'), env: { DATABASE_DB: 'test', DATABASE_USER: 'tester' } })).rejects.toThrow();
});

test('preserves dedicated reaction Redis and media settings used for existing note attachments', async () => {
	const value = await loadConfig({ configFile: await config(`mediaProxy: https://media.test/
videoThumbnailGenerator: https://video.test/
redisForReactions: {host: reactions, port: 6381, db: 5, prefix: reaction-prefix}`), env: { DATABASE_DB: 'test', DATABASE_USER: 'tester' } });
	expect(value.redisForReactions).toMatchObject({ host: 'reactions', port: 6381, db: 5, keyPrefix: 'reaction-prefix:' });
	expect(value.noteMedia).toEqual({ mediaProxy: 'https://media.test', externalMediaProxyEnabled: true, videoThumbnailGenerator: 'https://video.test' });
});
