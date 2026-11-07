/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { resolve } from 'node:path';
import { MiNote, MiUser, MiUserProfile, MiMeta } from 'backend-upstream/entities';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
const codec = createIdCodec('aidx');
const actor = { id: codec.newId(Date.now()), token: 'featured00000001' };
const authorId = codec.newId(Date.now());
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiUser).insert([{ ...actor, username: 'actor', usernameLower: 'actor' }, { id: authorId, username: 'original', usernameLower: 'original' }]);
	await source.getRepository(MiUserProfile).insert([{ userId: actor.id }, { userId: authorId }]);
	await source.getRepository(MiMeta).insert({ id: 'singleton', rootUserId: actor.id });
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('ordinary HTTP child accepts Renote then SIGTERM drains normal Redis scores and exits zero', async () => {
	const original = codec.newId(Date.now());
	await source.getRepository(MiNote).insert({ id: original, userId: authorId, text: 'target', visibility: 'public', localOnly: true });
	const port = await freePort();
	const redisForTimelines = { ...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-timeline`, keyPrefix: `${database.config.redis.prefix}-timeline:` };
	const config = await configuration({ ...database.config, redisForTimelines, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const observer = new Redis(database.config.redis);
	const timeline = new Redis(redisForTimelines);
	const preload = resolve('test/fixtures/featured-random.mjs');
	const child = launch('built/entrypoints/http.js', config.path, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}` });
	try {
		await child.ready;
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: actor.token, renoteId: original, localOnly: true }) });
		expect(response.status, await response.clone().text()).toBe(200);
		const note = (await response.json() as { createdNote: { id: string } }).createdNote;
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
		const elapsed = Date.now() - Date.parse('2023-01-01T00:00:00Z');
		const keys = [`featuredGlobalNotesRanking:${Math.floor(elapsed / 259200000)}`, `featuredPerUserNotesRanking:${authorId}:${Math.floor(elapsed / 604800000)}`];
		for (const key of keys) {
			expect(await observer.zscore(key, original)).toBe('5');
			expect(await timeline.exists(key)).toBe(0);
		}
		expect(await source.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
		expect((await source.getRepository(MiNote).findOneByOrFail({ id: original })).renoteCount).toBe(1);
		expect(child.output()).not.toContain('note-post-save.failed');
	} finally {
		await child.close();
		observer.disconnect();
		timeline.disconnect();
		await config.close();
	}
});
