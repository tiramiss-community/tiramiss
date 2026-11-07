/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiHashtag, MiNote, MiUser, MiUserProfile, MiMeta } from 'backend-upstream/entities';
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
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiUser).insert({ ...actor, username: 'actor', usernameLower: 'actor' });
	await source.getRepository(MiUserProfile).insert({ userId: actor.id });
	await source.getRepository(MiMeta).insert({ id: 'singleton', rootUserId: actor.id });
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('ordinary HTTP child accepts tagged Note then SIGTERM drains DB and normal Redis before exiting zero', async () => {
	const port = await freePort();
	const redisForTimelines = { ...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-timeline`, keyPrefix: `${database.config.redis.prefix}-timeline:` };
	const config = await configuration({ ...database.config, redisForTimelines, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const observer = new Redis(database.config.redis);
	const timeline = new Redis(redisForTimelines);
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: actor.token, text: '#Drain', localOnly: true }) });
		expect(response.status, await response.clone().text()).toBe(200);
		const note = (await response.json() as { createdNote: { id: string } }).createdNote;
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
		const key = `featuredHashtagsRanking:${Math.floor((Date.now() - Date.parse('2023-01-01T00:00:00Z')) / 3600000)}`;
		expect(await observer.zscore(key, 'drain')).toBe('1');
		expect(await observer.smembers('hashtagUsers:drain')).toEqual([actor.id]);
		expect(await timeline.exists(key, 'hashtagUsers:drain')).toBe(0);
		expect(await source.getRepository(MiHashtag).findOneByOrFail({ name: 'drain' })).toMatchObject({ mentionedUserIds: [actor.id], mentionedUsersCount: 1 });
		expect(await source.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
		expect((await source.getRepository(MiUser).findOneByOrFail({ id: actor.id })).notesCount).toBe(1);
		expect(child.output()).not.toContain('note-post-save.failed');
	} finally {
		await child.close();
		observer.disconnect();
		timeline.disconnect();
		await config.close();
	}
});
