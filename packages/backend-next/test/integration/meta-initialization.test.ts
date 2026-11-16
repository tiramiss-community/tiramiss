/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiMeta } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let control: DataSource;
const logger = { info() {}, error() {} };

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	control = await createDataSource(database.config.database).initialize();
});
afterAll(async () => {
	await control?.destroy();
	await database?.close();
});

test.each([false, true])('resources close waits for a real blocked Meta read before releasing PostgreSQL and Redis (cancel=%s)', async cancel => {
	await control.getRepository(MiMeta).deleteAll();
	const resources = await connectResources(database.config, logger);
	await resources.meta.fetch();
	const blocker = control.createQueryRunner();
	await blocker.connect();
	await blocker.startTransaction();
	let reading: Promise<unknown> | undefined;
	let closing: Promise<void> | undefined;
	try {
		// An independent connection blocks the actual repository SELECT, not a mocked Promise.
		await blocker.query('LOCK TABLE "meta" IN ACCESS EXCLUSIVE MODE');
		let readSettled = false;
		reading = resources.meta.fetch(true).then(meta => {
			readSettled = true;
			return { meta };
		}, error => {
			readSettled = true;
			return { error };
		});
		let pid: number | undefined;
		await vi.waitFor(async () => {
			const rows = await control.query('SELECT activity.pid FROM pg_stat_activity activity JOIN pg_locks locks ON locks.pid = activity.pid WHERE activity.datname = $1 AND activity.wait_event_type = $2 AND locks.relation = $3::regclass AND NOT locks.granted', [database.config.database.database, 'Lock', 'meta']);
			expect(rows).toHaveLength(1);
			pid = rows[0].pid;
		});
		let closed = false;
		closing = resources.close().then(() => {
			closed = true;
		});
		// Reaching the cache's closed state proves that cleanup has reached its pending-read drain.
		await vi.waitFor(async () => {
			await expect(resources.meta.fetch()).rejects.toThrow('Meta cache is closed');
		});
		expect(readSettled).toBe(false);
		expect(closed).toBe(false);
		expect(resources.dataSource.isInitialized).toBe(true);
		expect(await resources.dataSource.query('SELECT 1 AS alive')).toEqual([{ alive: 1 }]);
		expect(await resources.redis.ping()).toBe('PONG');
		if (cancel) {
			expect(await control.query('SELECT pg_cancel_backend($1) AS cancelled', [pid])).toEqual([{ cancelled: true }]);
			expect(await reading).toMatchObject({ error: { driverError: { code: '57014' } } });
		} else {
			await blocker.commitTransaction();
			expect(await reading).toMatchObject({ meta: { id: 'x' } });
			expect(await control.getRepository(MiMeta).find({ select: { id: true } })).toEqual([{ id: 'x' }]);
		}
		await closing;
		expect(resources.dataSource.isInitialized).toBe(false);
		expect(resources.redis.status).toBe('end');
		await expect(resources.meta.fetch(true)).rejects.toThrow('Meta cache is closed');
	} finally {
		if (blocker.isTransactionActive) {
			await blocker.rollbackTransaction();
		}
		await blocker.release();
		await reading;
		await (closing ?? resources.close());
	}
});

test('a failed cold Meta initialization rejects and does not cache a successful fallback', async () => {
	await control.getRepository(MiMeta).deleteAll();
	const resources = await connectResources(database.config, logger);
	try {
		await control.query('ALTER TABLE "meta" RENAME TO "meta_initialization_fault"');
		try {
			await expect(resources.meta.fetch()).rejects.toMatchObject({ driverError: { code: '42P01' } });
			await expect(resources.meta.fetch()).rejects.toMatchObject({ driverError: { code: '42P01' } });
		} finally {
			await control.query('ALTER TABLE "meta_initialization_fault" RENAME TO "meta"');
		}
		expect(await resources.meta.fetch()).toMatchObject({ id: 'x' });
		expect(await control.getRepository(MiMeta).count()).toBe(1);
	} finally {
		await resources.close();
	}
});
