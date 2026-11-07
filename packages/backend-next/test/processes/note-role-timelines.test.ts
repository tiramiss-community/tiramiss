/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { MiRoleAssignment } from 'backend-upstream/entities';
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

test('ordinary HTTP child drains role cache and host-topic publication before graceful exit', async () => {
	const port = await freePort();
	const prefix = `timeline174-${randomUUID()}`;
	const redisForTimelines = { ...database.config.redis, db: 6, prefix, keyPrefix: `${prefix}:` };
	const config = await configuration({ ...database.config, redisForTimelines, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const observer = new Redis(redisForTimelines);
	await source.getRepository(MiRoleAssignment).insert({ id: seeded.codec.newId(Date.now()), roleId: seeded.roleId, userId: seeded.actors.ordinary.id });
	const publications: unknown[] = [];
	const subscriber = new Redis(database.config.redisForPubsub);
	subscriber.on('message', (_channel, value) => {
		const event = JSON.parse(value);
		if (event.channel === `roleTimelineStream:${seeded.roleId}`) {
			publications.push(event);
		}
	});
	await subscriber.subscribe(new URL(database.config.url).host);
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, text: 'child timeline', localOnly: true }) });
		expect(response.status, await response.clone().text()).toBe(200);
		const note = (await response.json() as { createdNote: { id: string } }).createdNote;
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
		expect(await observer.lrange(`list:roleTimeline:${seeded.roleId}`, 0, -1)).toEqual([note.id]);
		await subscriber.ping();
		expect(publications).toEqual([{ channel: `roleTimelineStream:${seeded.roleId}`, message: { type: 'note', body: expect.objectContaining({ id: note.id, text: 'child timeline' }) } }]);
	} finally {
		await child.close();
		observer.disconnect();
		subscriber.disconnect();
		await config.close();
	}
});
