/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiEmoji, MiMeta, MiNote, MiUser } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string, rootId: string;
const names = Array.from({ length: 10 }, (_, index) => `batch${index}`);
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('emoji-batch-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'z', federation: 'all', ugcVisibilityForVisitor: 'all', enableStatsForFederatedInstances: false });
	const users = ['batchauthor0', 'batchauthor1', 'batchauthor2'];
	await resources.dataSource.getRepository(MiUser).insert(users.map(id => ({ id, username: id, usernameLower: id, host: 'batch.test', emojis: [...names] })));
	await resources.dataSource.getRepository(MiEmoji).insert(names.map((name, index) => ({ id: `batchemoji${index}`, name, host: 'batch.test', publicUrl: `https://batch.test/${name}`, originalUrl: `https://batch.test/${name}` })));
	const codec = createIdCodec('aidx'); const ids = users.map(() => codec.newId(Date.now())); rootId = ids[0];
	for (const index of [2, 1, 0]) {
		await resources.dataSource.getRepository(MiNote).insert({ id: ids[index], userId: users[index], userHost: 'batch.test', text: 'actor batch fixture', visibility: 'public', ...(index === 0 ? { replyId: ids[1], renoteId: ids[2] } : {}) });
	}
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	} await resources?.close(); await database?.close();
});

test('one Note read fetches ten shared author emojis once when cold and does no emoji query when warm', async () => {
	const queries: string[] = [];
	const logger = resources.dataSource.logger;
	const original = logger.logQuery.bind(logger);
	const observed = vi.spyOn(logger, 'logQuery').mockImplementation((query, parameters, runner) => {
		if (/^SELECT\b/.test(query) && /FROM "emoji"/.test(query)) {
			queries.push(query);
		}
		original(query, parameters, runner);
	});

	async function read() {
		const response = await fetch(`${url}/api/notes/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId: rootId }) });
		expect(response.status).toBe(200); const body = await response.json();
		const expected = Object.fromEntries(names.map(name => [name, `https://batch.test/${name}`]));
		expect([body.user.emojis, body.reply.user.emojis, body.renote.user.emojis]).toEqual([expected, expected, expected]);
	}

	try {
		await read(); expect(queries).toHaveLength(1);
		queries.length = 0; await read(); expect(queries).toHaveLength(0);
	} finally {
		observed.mockRestore();
	}
});
