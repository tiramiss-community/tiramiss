/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seeded = await seedRoleHttp(source);
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('ordinary HTTP child drains a saved note into dedicated timeline Redis before graceful exit', async () => {
	const port = await freePort();
	const prefix = `timeline174-${randomUUID()}`;
	const redisForTimelines = { ...database.config.redis, db: 6, prefix, keyPrefix: `${prefix}:` };
	const config = await configuration({ ...database.config, redisForTimelines, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const observer = new Redis(redisForTimelines);
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, text: 'child timeline', localOnly: true }) });
		expect(response.status, await response.clone().text()).toBe(200);
		const note = (await response.json() as { createdNote: { id: string } }).createdNote;
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
		expect(await observer.lrange('list:localTimeline', 0, -1)).toEqual([note.id]);
		expect(await observer.lrange(`list:userTimeline:${seeded.actors.ordinary.id}`, 0, -1)).toEqual([note.id]);
	} finally {
		await child.close();
		observer.disconnect();
		await config.close();
	}
});

test('loss of a dedicated timeline Redis connection stops the ordinary HTTP child', async () => {
	const port = await freePort();
	const connectionName = `timeline174-${randomUUID()}`;
	const config = await configuration({ ...database.config, redisForTimelines: { ...database.config.redis, db: 6, connectionName }, http: { port } });
	const observer = new Redis(database.config.redis);
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		const line = String(await observer.client('LIST')).split('\n').find(entry => entry.includes(`name=${connectionName} `));
		expect(line).toBeDefined();
		await observer.client('KILL', 'ID', line!.match(/^id=(\d+)/)![1]);
		expect((await child.exit).code, child.output()).toBe(1);
		expect(child.output()).toContain('TIMELINES_REDIS_ENDED');
	} finally {
		await child.close();
		observer.disconnect();
		await config.close();
	}
});
