/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiDriveFile, MiDriveFolder, MiMeta, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';
import type { DriveStoredFile } from '../../src/modules/drive/files.js';
import type { DriveFolderRow } from '../../src/modules/drive/folders.js';
const dir = new URL('../../../../docs/superpowers/compatibility/drive-files/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', dir), 'utf8')) as { rows: DriveStoredFile[]; folders: DriveFolderRow[]; cases: { id: string; operation: string; actor: string; input: object; fail?: boolean }[] };
const source = JSON.parse(readFileSync(new URL('observations.json', dir), 'utf8')) as { cases: { id: string; expected: { result?: unknown; error?: { code?: string; id?: string; message?: string } } }[] };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let server: Server;
let origin: string;
const actors = ['alice', 'bob', 'mod'];
const token = (actor: string) => `native${String(actors.indexOf(actor)).padStart(10, '0')}`;
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	database.config.url = 'https://local'; database.config.noteMedia = { mediaProxy: 'https://local/proxy', externalMediaProxyEnabled: false, videoThumbnailGenerator: 'https://video' };
	resources = await connectResources(database.config, createLogger('source-file-http', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	await resources.dataSource.getRepository(MiUser).insert(actors.map(username => ({ id: username, username, usernameLower: username, token: token(username) })));
	await resources.dataSource.getRepository(MiRole).insert({ id: 'role', name: 'moderator', description: '', isModerator: true, updatedAt: new Date(), lastUsedAt: new Date() });
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: 'assignment', roleId: 'role', userId: 'mod', expiresAt: null });
	await resources.dataSource.getRepository(MiDriveFolder).insert(corpus.folders);
	await resources.dataSource.getRepository(MiDriveFile).insert(corpus.rows);
	app = createBackendHttpApp(resources, database.config); server = await listenHttp(app, { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	} if (app) {
		await drainHttpAppWork(app);
	} await resources?.close(); await database?.close(); 
});

function userIdentity(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(userIdentity);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key === 'user' && v ? { id: (v as { id: string }).id, username: (v as { username: string }).username } : userIdentity(v)]));
	}
	return value;
}

const path: Record<string, string> = { show: 'drive/files/show', find: 'drive/files/find', findByHash: 'drive/files/find-by-hash', checkExistence: 'drive/files/check-existence', adminShow: 'admin/drive/show-file' };
for (const c of corpus.cases) {
	test(`real HTTP/PG source binding ${c.id}`, async () => {
		const failure = c.fail ? vi.spyOn(resources.dataSource.getRepository(MiDriveFile), 'findOneBy').mockRejectedValueOnce(Error('database unavailable')) : null;
		let response: Response;
		try {
			response = await fetch(`${origin}/api/${path[c.operation]}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(c.actor)}` }, body: JSON.stringify(c.input) }); 
		} finally {
			failure?.mockRestore(); 
		}
		const body = await response.json();
		if (c.operation === 'adminShow' && c.actor !== 'mod') {
		// Pinned source observations call handlers after ApiCallService; ordinary callers stop at the real common gate.
			expect(response.status).toBe(403); expect(body).toHaveProperty('error.code', 'ROLE_PERMISSION_DENIED'); return;
		}
		const expected = source.cases.find(s => s.id === c.id)!.expected;
		if (expected.error) {
			expect(response.status).toBe(expected.error.message ? 500 : 400);
			if (expected.error.message) {
				expect(body).toHaveProperty('error.info.e.message', expected.error.message);
			} else {
				expect(body).toMatchObject({ error: expected.error });
			}
		} else {
			expect(response.status, JSON.stringify(body)).toBe(200);
			// UserLite's identity is the oracle double's contract; full real UserLite fields are separately asserted in drive-files.test.ts.
			expect(userIdentity(body)).toEqual(expected.result);
		}
	});
}
