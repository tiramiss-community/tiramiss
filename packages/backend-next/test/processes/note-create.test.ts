/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { request } from 'node:http';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiNote, MiPoll, MiUser } from 'backend-upstream/entities';
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

test.each([false, true].flatMap(disconnected => [false, true].map(poll => ({ disconnected, poll }))))('accepted Note survives shutdown and client disconnect=$disconnected poll=$poll, with count updated once', async ({ disconnected, poll }) => {
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const child = launch('built/entrypoints/http.js', config.path);
	const blocker = source.createQueryRunner();
	let req: ReturnType<typeof request> | undefined;
	try {
		await child.ready;
		const before = await source.getRepository(MiUser).findOneByOrFail({ id: seeded.actors.ordinary.id });
		await blocker.startTransaction();
		await blocker.query('LOCK TABLE note IN SHARE MODE');
		const text = `drained-note-${disconnected}-${poll}`;
		const result = new Promise<number | 'disconnected'>(resolve => {
			req = request({ hostname: '127.0.0.1', port, path: '/api/notes/create', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
				response.resume();
				response.on('end', () => resolve(response.statusCode!));
			});
			req.on('error', () => resolve('disconnected'));
			req.end(JSON.stringify({ text, ...(poll ? { poll: { choices: ['a', 'b'] } } : {}), i: seeded.actors.ordinary.token }));
		});
		await vi.waitFor(async () => {
			const waiting = await source.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=\'Lock\' AND query LIKE \'INSERT INTO %note%\'');
			expect(waiting.length).toBe(1);
		}, { timeout: 5000 });
		if (disconnected) {
			req!.destroy();
		}
		child.child.kill('SIGTERM');
		await blocker.commitTransaction();
		expect(await result).toBe(disconnected ? 'disconnected' : 200);
		expect((await child.exit).code, child.output()).toBe(0);
		expect(await source.getRepository(MiNote).countBy({ userId: before.id, text })).toBe(1);
		const note = await source.getRepository(MiNote).findOneByOrFail({ userId: before.id, text });
		expect(await source.getRepository(MiPoll).countBy({ noteId: note.id })).toBe(poll ? 1 : 0);
		expect((await source.getRepository(MiUser).findOneByOrFail({ id: before.id })).notesCount).toBe(before.notesCount + 1);
		expect(child.output()).not.toContain('note-post-save.failed');
	} finally {
		req?.destroy();
		if (blocker.isTransactionActive) {
			await blocker.rollbackTransaction();
		}
		await blocker.release();
		await child.close();
		await config.close();
	}
});
