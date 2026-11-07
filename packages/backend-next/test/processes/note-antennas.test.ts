/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAntenna, MiInstance, MiNote, MiMeta, MiUser, MiUserProfile, MiUserList } from 'backend-upstream/entities';
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
const actor = { id: codec.newId(Date.now()), token: 'antenna000000001' };
const owner = codec.newId(Date.now());
const listId = codec.newId(Date.now());
const antennaId = codec.newId(Date.now());
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiUser).insert([{ ...actor, username: 'actor', usernameLower: 'actor' }, { id: owner, username: 'owner', usernameLower: 'owner' }]);
	await source.getRepository(MiUserProfile).insert({ userId: actor.id });
	await source.getRepository(MiMeta).insert({ id: 'singleton', rootUserId: actor.id });
	await source.getRepository(MiUserList).insert({ id: listId, userId: owner, name: 'list' });
	await source.query('INSERT INTO user_list_membership (id,"userId","userListId","userListUserId") VALUES ($1,$2,$3,$4)', [codec.newId(Date.now()), actor.id, listId, owner]);
	await source.getRepository(MiAntenna).insert({
		id: antennaId, userId: owner, name: 'antenna', src: 'list', userListId: listId, withFile: false, withReplies: true, lastUsedAt: new Date()
	});
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});
test('normal HTTP child SIGTERM drains a blocked antenna lookup, its timeline and raw publication before zero exit', async () => {
	const port = await freePort();
	const redisForTimelines = {
		...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-timeline`, keyPrefix: `${database.config.redis.prefix}-timeline:`
	};
	const config = await configuration({
		...database.config, redisForTimelines, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 10000 }
	});
	const timeline = new Redis(redisForTimelines);
	const subscriber = new Redis(database.config.redisForPubsub);
	const envelopes: {
		channel: string;
		message: {
			type: string;
			body: Record<string, unknown>;
		};
	}[] = [];
	subscriber.on('message', (_topic, encoded) => {
		envelopes.push(JSON.parse(encoded));
	});
	await subscriber.subscribe(new URL(database.config.url).host);
	const child = launch('built/entrypoints/http.js', config.path);
	const runner = source.createQueryRunner();
	let locked = false;
	try {
		await child.ready;
		await runner.startTransaction();
		locked = true;
		await runner.query('LOCK TABLE user_list_membership IN ACCESS EXCLUSIVE MODE');
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: actor.token, text: 'drain raw antenna', localOnly: true }) });
		expect(response.status, await response.clone().text()).toBe(200);
		const note = (await response.json() as {
			createdNote: {
				id: string;
			};
		}).createdNote;
		child.child.kill('SIGTERM');
		let exited = false;
		void child.exit.then(() => {
			exited = true;
		});
		await new Promise(resolve => setTimeout(resolve, 150));
		expect(exited, child.output()).toBe(false);
		expect(await timeline.lrange(`list:antennaTimeline:${antennaId}`, 0, -1)).toEqual([]);
		await runner.commitTransaction();
		locked = false;
		expect((await child.exit).code, child.output()).toBe(0);
		expect(await timeline.lrange(`list:antennaTimeline:${antennaId}`, 0, -1)).toEqual([note.id]);
		const envelope = envelopes.find(value => value.channel === `antennaStream:${antennaId}`);
		expect(envelope?.message).toEqual({ type: 'note', body: expect.objectContaining({
				id: note.id, text: 'drain raw antenna', userId: actor.id, mentionedRemoteUsers: '[]', repliesCount: 0, renoteCount: 0, channel: null, reply: null, renote: null
			}) });
		expect(envelope?.message.body).not.toHaveProperty('createdAt');
		expect(child.output()).not.toContain('note-post-save.failed');
	} finally {
		if (locked) {
			await runner.rollbackTransaction();
		}
		await runner.release();
		await child.close();
		subscriber.disconnect();
		timeline.disconnect();
		await config.close();
	}
});
test('managed child flushes queued production five-minute instance increments before database disposal and exits without a timer', async () => {
	const remote = codec.newId(Date.now());
	const noteId = codec.newId(Date.now());
	await source.getRepository(MiUser).insert({
		id: remote, username: 'remote', usernameLower: 'remote', host: 'shutdown.example'
	});
	await source.getRepository(MiUserProfile).insert({ userId: remote });
	await source.getRepository(MiNote).insert({
		id: noteId, userId: remote, userHost: 'shutdown.example', text: 'remote', visibility: 'public', localOnly: true
	});
	await source.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
	const config = await configuration({ ...database.config, http: { port: await freePort() }, processes: { ...database.config.processes, shutdownTimeoutMs: 10000 } });
	const child = launch('test/fixtures/note-instance-counts.mjs', config.path, { NODE_ENV: 'production', FIXTURE_NOTE_ID: noteId });
	try {
		await child.ready;
		expect((await source.getRepository(MiInstance).findOneByOrFail({ host: 'shutdown.example' })).notesCount).toBe(0);
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
		expect((await source.getRepository(MiInstance).findOneByOrFail({ host: 'shutdown.example' })).notesCount).toBe(1);
		expect(child.output()).not.toContain('note-instance-counts.failed');
	} finally {
		await child.close();
		await config.close();
	}
});
