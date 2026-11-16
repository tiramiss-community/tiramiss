/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiEmoji, MiMeta, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: Awaited<ReturnType<typeof createDataSource>>;
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	const pair = await generateRsaKeyPair();
	await source.getRepository(MiMeta).insert({ id: 'z', federation: 'all' });
	await source.getRepository(MiUser).insert({ id: 'local', username: 'alice', usernameLower: 'alice', emojis: ['wave'] });
	await source.getRepository(MiUserProfile).insert({ userId: 'local' });
	await source.getRepository(MiUserKeypair).insert({ userId: 'local', publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	await source.getRepository(MiEmoji).insert({ id: 'wave', name: 'wave', host: null, publicUrl: 'https://emoji.test/wave', originalUrl: 'https://emoji.test/wave' });
});
afterAll(async () => {
	await source?.destroy(); await database?.close();
});

test('SIGTERM waits for an accepted cold actor emoji read, releases the cache timer and exits cleanly', async () => {
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 10000 } });
	const child = launch('built/entrypoints/http.js', config.path);
	const lock = source.createQueryRunner();
	let request: Promise<Response> | undefined;
	try {
		await child.ready;
		await lock.connect(); await lock.startTransaction(); await lock.query('LOCK TABLE "emoji" IN ACCESS EXCLUSIVE MODE');
		request = fetch(`http://127.0.0.1:${port}/users/local`, { headers: { Accept: 'application/activity+json' } });
		await vi.waitFor(async () => {
			const rows = await source.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\' AND query LIKE \'%FROM "emoji"%\'');
			expect(rows[0].count).toBeGreaterThan(0);
		});
		child.child.kill('SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(child.child.exitCode).toBeNull();
		await lock.commitTransaction();
		const response = await request; expect(response.status).toBe(200);
		expect((await response.json()).tag[0].icon.url).toBe('https://emoji.test/wave');
		expect(await child.exit).toEqual({ code: 0, signal: null });
	} finally {
		if (lock.isTransactionActive) {
			await lock.rollbackTransaction();
		}
		await lock.release(); await request?.catch(() => {}); await child.close(); await config.close();
	}
});
