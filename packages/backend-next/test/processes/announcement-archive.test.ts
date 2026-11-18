/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Queue } from 'bullmq';
import { MiAnnouncement } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let queue: Queue;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	queue = new Queue('system', baseQueueOptions(database.config.redisForJobQueue, 'system', 5000));
});

afterAll(async () => {
	await queue?.obliterate({ force: true });
	await queue?.close();
	await source?.destroy();
	await database?.close();
});

test('ordinary worker entrypoint restores persisted reservations, honors deadlines, drains on stop and restores after reservation loss', async () => {
	const announcements = source.getRepository(MiAnnouncement);
	const date = new Date(Date.now() + 2000);
	await announcements.insert({ id: 'processarchive', title: 'Process', text: 'Process', autoArchiveAt: date });
	const file = await configuration({ ...database.config, http: { port: await freePort() } });
	let child = launch('built/entrypoints/worker.js', file.path);
	try {
		await child.ready;
		await vi.waitFor(async () => expect(await announcements.findOneByOrFail({ id: 'processarchive' })).toMatchObject({ isActive: false, updatedAt: expect.any(Date) }), { timeout: 10000 });
		expect((await announcements.findOneByOrFail({ id: 'processarchive' })).updatedAt!.getTime()).toBeGreaterThanOrEqual(date.getTime());
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
		await child.close();
		await queue.obliterate({ force: true });
		const again = new Date(Date.now() - 1000);
		await announcements.update('processarchive', { isActive: true, updatedAt: null, autoArchiveAt: again });
		child = launch('built/entrypoints/worker.js', file.path);
		await child.ready;
		await vi.waitFor(async () => expect(await announcements.findOneByOrFail({ id: 'processarchive' })).toMatchObject({ isActive: false, updatedAt: expect.any(Date) }), { timeout: 10000 });
		expect((await queue.getJob(`archiveAnnouncement-processarchive-${again.getTime()}`))!.name).toBe('archiveAnnouncement');
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
	} finally {
		await child.close();
		await file.close();
	}
});
