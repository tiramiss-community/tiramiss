/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiDriveFile, MiDriveFolder, MiMeta, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createDriveUsageReader } from '../../src/platform/database/drive-list-usage.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';
import type { DriveUsageSelection } from '../../src/modules/drive/list-usage.js';
const directory = new URL('../../../../docs/superpowers/compatibility/drive-list-usage/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	rows: { id: string; userId: string | null; userHost: string | null; folderId: string | null; name: string; type: string; size: number; isLink: boolean }[];
	folders: { id: string; userId: string; parentId: string | null; name: string }[];
	cases: { id: string; operation: string; input: object; actor?: string }[];
};
const observations = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as { cases: { id: string; result?: unknown; error?: string }[] };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let server: Server;
let origin: string;
const token = (actor: string) => `native${actor.padStart(10, '0')}`;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('source-list-http', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	await resources.dataSource.getRepository(MiUser).insert(['alice', 'bob', 'mod', 'empty'].map(username => ({ id: username, username, usernameLower: username, token: token(username) })));
	await resources.dataSource.getRepository(MiRole).insert({ id: 'role', name: 'moderator', description: '', isModerator: true, updatedAt: new Date(), lastUsedAt: new Date() });
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: 'assignment', roleId: 'role', userId: 'mod' });
	await resources.dataSource.getRepository(MiDriveFolder).insert(corpus.folders);
	await resources.dataSource.getRepository(MiDriveFile).insert(corpus.rows.map(row => ({ ...row, storedInternal: true, url: `https://files/${row.id}`, md5: row.id })));
	app = createBackendHttpApp(resources, database.config);
	server = await listenHttp(app, { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	if (app) {
		await drainHttpAppWork(app);
	}
	await resources?.close();
	await database?.close();
});
const paths: Record<string, string> = { usage: 'drive', files: 'drive/files', stream: 'drive/stream', folders: 'drive/folders', adminFiles: 'admin/drive/files' };
for (const c of corpus.cases) {
	test(`pinned source PostgreSQL to real HTTP/PG: ${c.id}`, async () => {
		const expected = observations.cases.find(observation => observation.id === c.id)!;
		if (c.operation === 'aggregate') {
			expect(await createDriveUsageReader(resources.dataSource.manager)(c.input as DriveUsageSelection)).toEqual(expected.result);
			return;
		}
		const response = await fetch(`${origin}/api/${paths[c.operation]}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(c.operation === 'adminFiles' ? 'mod' : c.actor ?? 'alice')}` }, body: JSON.stringify(c.input) });
		const body = await response.json();
		if (expected.error) {
			expect(response.status).toBe(400);
			expect(body).toHaveProperty('error.code', expected.error);
		} else {
			expect(response.status, JSON.stringify(body)).toBe(200);
			expect(Array.isArray(body) ? body.map((row: { id: string }) => row.id) : body).toEqual(expected.result);
		}
	});
}
