/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiPage, MiPageLike, MiUser, MiMeta, MiDriveFile, MiAccessToken } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';
import type { PageRow } from '../../src/modules/page/public.js';
import type { DriveStoredFile } from '../../src/modules/drive/files.js';
const directory = new URL('../../../../docs/superpowers/compatibility/page-read/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	users: { id: string; username: string; usernameLower: string; host: string | null }[];
	files: DriveStoredFile[]; pages: (Omit<PageRow, 'updatedAt'> & { updatedAt: string })[];
	likes: { pageId: string; userId: string }[];
	cases: { id: string; actor?: string; input: { pageId?: string | null }; failWrite?: boolean; failRead?: boolean; missingEye?: boolean }[];
};
const source = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	cases: { id: string; expected: { result?: unknown; error?: { code?: string; message?: string; id?: string }; writes: { content: object[]; state: string }[]; persistedContent?: object[] } }[];
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let server: Server;
let origin: string;
const diagnostics: string[] = [];
const token = (id: string) => `page${id.padEnd(12, '0')}`;
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	database.config.url = 'https://local'; database.config.noteMedia = { mediaProxy: 'https://local/proxy', externalMediaProxyEnabled: false };
	resources = await connectResources(database.config, createLogger('page-read-http', line => {
		diagnostics.push(line);
	}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	await resources.dataSource.getRepository(MiUser).insert(corpus.users.map(user => ({ ...user, token: user.host ? null : token(user.id) })));
	await resources.dataSource.getRepository(MiDriveFile).insert(corpus.files);
	app = createBackendHttpApp(resources, database.config); server = await listenHttp(app, { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	if (app) {
		await drainHttpAppWork(app);
	}
	await resources?.close(); await database?.close();
});

function identity(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(identity);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'user' && item ? { id: (item as { id: string }).id, username: (item as { username: string }).username } : identity(item)]));
	}
	return value;
}

for (const c of corpus.cases) {
	test(`normal HTTP and real PG match imported Page source: ${c.id}`, async () => {
		const pages = resources.dataSource.getRepository(MiPage);
		await pages.createQueryBuilder().delete().execute();
		for (const page of corpus.pages) {
			await pages.createQueryBuilder().insert().values({ ...page, updatedAt: new Date(page.updatedAt), content: () => 'CAST(:content AS jsonb)', variables: () => 'CAST(:variables AS jsonb)' })
				.setParameters({ content: JSON.stringify(page.content), variables: JSON.stringify(page.variables) }).execute();
		}
		await resources.dataSource.getRepository(MiPageLike).insert(corpus.likes.map((like, index) => ({ ...like, id: `like${index}` })));
		const expected = source.cases.find(row => row.id === c.id)!.expected;
		const old = await pages.findOneByOrFail({ id: c.input.pageId ?? corpus.pages[0].id }).catch(() => null);
		// FKs prevent a stored missing eye catch; emulate a deletion between separate reads.
		const read = c.failRead ? vi.spyOn(pages, 'findOneBy').mockRejectedValueOnce(Error('page read failed'))
			: c.missingEye ? vi.spyOn(pages, 'findOneBy').mockResolvedValueOnce({ ...old!, eyeCatchingImageId: 'missing' } as MiPage) : null;
		if (c.failWrite) {
			await resources.dataSource.query(`CREATE FUNCTION fail_page_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'write failed'; END $$`);
			await resources.dataSource.query('CREATE TRIGGER page_write_failure BEFORE UPDATE ON page FOR EACH ROW EXECUTE FUNCTION fail_page_write()');
		}
		let response: Response;
		try {
			response = await fetch(`${origin}/api/pages/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(c.actor ? { Authorization: `Bearer ${token(c.actor)}` } : {}) }, body: JSON.stringify(c.input) });
			await drainHttpAppWork(app);
		} finally {
			read?.mockRestore();
			if (c.failWrite) {
				await resources.dataSource.query('DROP TRIGGER page_write_failure ON page');
				await resources.dataSource.query('DROP FUNCTION fail_page_write()');
			}
		}
		const body = await response.json();
		if (expected.error) {
			expect(response.status).toBe(expected.error.code ? 400 : 500);
			if (expected.error.code) {
				expect(body).toMatchObject({ error: expected.error });
			} else {
				expect(body).toHaveProperty('error.code', 'INTERNAL_ERROR');
			}
		} else {
			expect(response.status, JSON.stringify(body)).toBe(200);
			expect(identity(body)).toEqual(expected.result);
			expect(body.user).toMatchObject({ id: 'alice', username: 'alice', host: null, isBot: false, isCat: false, emojis: {}, avatarDecorations: [], badgeRoles: [] });
			expect(body.user).not.toHaveProperty('pinnedPage');
		}
		if (expected.writes.length) {
			const persisted = await pages.findOneByOrFail({ id: c.input.pageId! });
			expect(persisted.content).toEqual(expected.persistedContent);
			if (c.failWrite) {
				expect(diagnostics.some(line => line.includes('page.content-write-failed'))).toBe(true);
			}
		} else if (old) {
			expect((await pages.findOneByOrFail({ id: old.id })).content).toEqual(old.content);
		}
	});
}

test('public endpoint rejects invalid tokens and GET is unavailable', async () => {
	const invalid = await fetch(`${origin}/api/pages/show`, { method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: corpus.pages[0].id }) });
	expect(invalid.status).toBe(401); expect(await invalid.json()).toHaveProperty('error.code', 'AUTHENTICATION_FAILED');
	expect((await fetch(`${origin}/api/pages/show`)).status).toBe(405);
});

test('PageLike metadata matches applied upstream migrations and public reads accept a token with no scopes', async () => {
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: 'pagetoken', token: 'page-app-token-without-scopes', hash: 'page-app-token-without-scopes', userId: 'bob', permission: [] });
	await resources.dataSource.getRepository(MiUser).update('bob', { isSuspended: true });
	try {
		const response = await fetch(`${origin}/api/pages/show`, { method: 'POST', headers: { Authorization: 'Bearer page-app-token-without-scopes', 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: corpus.pages[0].id }) });
		expect(response.status).toBe(200);
		expect(await response.json()).toHaveProperty('isLiked', true);
	} finally {
		await resources.dataSource.getRepository(MiUser).update('bob', { isSuspended: false });
	}
});

test('fixed Page modules use the pinned nullish-WHERE setup over real PostgreSQL for permissive content', async () => {
	const ids = ['image-id-missing', 'image-id-null', 'null-id-precedes-name', 'string-children'];
	const cases = corpus.cases.filter(c => ids.includes(c.id));
	const output = execFileSync(process.execPath, [new URL('source-probe.mjs', directory).pathname, '--pg'], {
		input: JSON.stringify({ database: database.config.database, cases }), encoding: 'utf8',
		env: { ...process.env, UPSTREAM_ROOT: process.env.BACKEND_NEXT_UPSTREAM_PATH ?? process.cwd() },
	});
	const observed = JSON.parse(output) as { id: string; result: unknown }[];
	for (const row of observed) {
		expect(row.result).toEqual(source.cases.find(c => c.id === row.id)!.expected.result);
	}
});
