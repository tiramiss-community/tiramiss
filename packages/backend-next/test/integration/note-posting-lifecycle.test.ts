/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiChannel, MiMeta, MiNote, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { createNoteContract } from '../helpers/note-contract.js';

const golden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8'));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const actors: Record<string, { id: string; token: string }> = {};
const { ids, prepare } = createNoteContract({
	idFields: new Set(), timeFields: new Set(), origin: () => database.config.url,
	create: (input, actor) => api('create', input, actor), settle: () => resources.notePostSave.idle(),
});

function api(endpoint: string, input: object, actor: string) {
	return app.request(`/api/notes/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: actors[actor].token, ...input }) });
}

beforeAll(async () => {
	// Historical counters survive deletion; keep them away from tests comparing live rows.
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('posting-lifecycle-test', () => {}));
	for (const name of ['outsider', 'alice', 'bob']) {
		actors[name] = { id: codec.newId(Date.now() - 100000), token: `life${name}`.padEnd(16, '0') };
		await resources.dataSource.getRepository(MiUser).insert({ id: actors[name].id, username: name, usernameLower: name, token: actors[name].token });
		await resources.dataSource.getRepository(MiUserProfile).insert({ userId: actors[name].id });
	}
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	app = createBackendHttpApp(resources, database.config);
});

afterAll(async () => {
	await resources?.close(); await database?.close();
});

test('C1-user-count matches fixed upstream create/delete history', async () => {
	const count = async () => (await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.outsider.id })).notesCount;
	const before = await count();
	await prepare('counter-note', { text: 'count' }, 'outsider');
	const afterCreate = await count();
	expect((await api('delete', { noteId: ids['counter-note'] }, 'outsider')).status).toBe(204);
	await resources.notePostDelete.idle();
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: ids['counter-note'] })).toBe(false);
	expect({ before, afterCreate, afterDelete: await count() }).toEqual(golden['C1-user-count']);
});

test('C8-channel-counts matches fixed upstream deletion and repost history', async () => {
	const channelId = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiChannel).insert({ id: channelId, name: 'channel', userId: actors.alice.id, allowRenoteToExternal: false });
	// reference-note.e2e.ts: Bob's prepared channelNote, C8-channel, then channel-first.
	await prepare('channelNote', { text: 'channel', channelId }, 'bob');
	await prepare('C8-channel', { text: 'channel', channelId }, 'alice');
	await prepare('channel-first', { text: 'one', channelId }, 'alice');
	const channel = await resources.dataSource.getRepository(MiChannel).findOneByOrFail({ id: channelId });
	expect(channel.lastNotedAt!.getTime()).toBeGreaterThanOrEqual(codec.createdAtFromId(ids['channel-first']));
	const counts = async () => {
		const row = await resources.dataSource.getRepository(MiChannel).findOneByOrFail({ id: channelId });
		return { notes: row.notesCount, users: row.usersCount };
	};
	const before = await counts();
	for (const name of ['C8-channel', 'channel-first']) {
		expect((await api('delete', { noteId: ids[name] }, 'alice')).status).toBe(204);
		await resources.notePostDelete.idle();
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: ids[name] })).toBe(false);
	}
	const afterDelete = await counts();
	await prepare('channel-again', { text: 'again', channelId }, 'alice');
	expect({ before, afterDelete, afterAgain: await counts() }).toEqual(golden['C8-channel-counts']);
});
