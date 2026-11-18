/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiUser } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createUsersCharts } from '../../src/modules/chart/public.js';
import { createNoteChartStore } from '../../src/platform/database/chart/store.js';
import { createUserChartCounts } from '../../src/platform/database/user-chart-counts.js';
import { noteChartSchemas } from '../../src/platform/database/chart/schema.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('users-chart-test', () => {}));
});
afterAll(async () => {
 await resources?.close(); await database?.close(); 
});

async function clear() {
	for (const span of ['hour', 'day'] as const) {
await resources.dataSource.getRepository(noteChartSchemas.users[span]).clear();
}
}

test('users EntitySchema matches all inherited migrations', async () => {
	await assertSchemaMatches(database.config.database);
});

test('hour/day transitions carry totals, preserve histories and resync counts deleted, suspended and system accounts', async () => {
	await clear();
	const db = resources.dataSource;
	await db.getRepository(MiUser).insert([
		{ id: 'local', username: 'local', usernameLower: 'local', isDeleted: true },
		{ id: 'system', username: 'system.actor', usernameLower: 'system.actor' },
		{ id: 'remote', username: 'remote', usernameLower: 'remote', host: 'remote.test', isSuspended: true },
	]);
	let now = Date.UTC(2026, 10, 18, 23, 59);
	const charts = createUsersCharts(createNoteChartStore(db, resources.redis), () => now, createUserChartCounts(db.manager));
	charts.update({ host: null }, true);
	charts.update({ host: 'remote.test' }, true);
	await charts.flush();
	now += 3 * 3600000;
	charts.update({ host: 'remote.test' }, false);
	await charts.flush();
	const before = await db.getRepository(noteChartSchemas.users.day).find({ order: { date: 'ASC' } });
	expect(await charts.read('hour', 4, null)).toEqual({ local: { total: [1, 1, 1, 1], inc: [0, 0, 0, 1], dec: [0, 0, 0, 0] }, remote: { total: [0, 1, 1, 1], inc: [0, 0, 0, 1], dec: [1, 0, 0, 0] } });
	await charts.resync();
	const after = await db.getRepository(noteChartSchemas.users.day).find({ order: { date: 'ASC' } });
	expect(after[0]).toEqual(before[0]);
	expect(after[1]).toMatchObject({ ___local_total: 2, ___remote_total: 1, ___remote_dec: 1 });
	await charts.resync();
	expect(await db.getRepository(noteChartSchemas.users.day).find({ order: { date: 'ASC' } })).toEqual(after);
});

test('concurrent first claim creates one row per span and small counters clamp', async () => {
	await clear();
	const db = resources.dataSource;
	const now = Date.UTC(2026, 10, 19, 2);
	const clients = [0, 1].map(() => createUsersCharts(createNoteChartStore(db, resources.redis), () => now, async () => ({ local: 0, remote: 0 })));
	for (const chart of clients) {
chart.update({ host: null }, true);
}
	await Promise.all(clients.map(chart => chart.flush()));
	for (const span of ['hour', 'day'] as const) {
		expect(await db.getRepository(noteChartSchemas.users[span]).find()).toMatchObject([{ ___local_total: 2, ___local_inc: 2 }]);
		await db.getRepository(noteChartSchemas.users[span]).createQueryBuilder().update().set({ ___local_inc: 32767, ___local_total: 2147483647, ___remote_total: -2147483648, ___remote_dec: 32767 }).execute();
	}
	clients[0].update({ host: null }, true);
	clients[0].update({ host: 'remote.test' }, false);
	await clients[0].flush();
	for (const span of ['hour', 'day'] as const) {
expect(await db.getRepository(noteChartSchemas.users[span]).find()).toMatchObject([{ ___local_inc: 32767, ___local_total: 2147483647, ___remote_total: -2147483648, ___remote_dec: 32767 }]);
}
});

test('day update failure leaves committed hour and drops detached changes', async () => {
	await clear();
	const db = resources.dataSource;
	const charts = createUsersCharts(createNoteChartStore(db, resources.redis), () => Date.UTC(2026, 10, 19, 2), async () => ({ local: 0, remote: 0 }));
	await db.query(`CREATE FUNCTION reject_users_day() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
	await db.query(`CREATE TRIGGER reject_users_day BEFORE UPDATE ON __chart_day__users FOR EACH ROW EXECUTE FUNCTION reject_users_day()`);
	try {
		charts.update({ host: null }, true);
		await expect(charts.flush()).rejects.toThrow();
		expect(await db.getRepository(noteChartSchemas.users.hour).find()).toMatchObject([{ ___local_total: 1 }]);
		expect(await db.getRepository(noteChartSchemas.users.day).find()).toMatchObject([{ ___local_total: 0 }]);
	} finally {
		await db.query('DROP TRIGGER reject_users_day ON __chart_day__users');
		await db.query('DROP FUNCTION reject_users_day()');
	}
	await charts.flush();
	expect(await db.getRepository(noteChartSchemas.users.day).find()).toMatchObject([{ ___local_total: 0 }]);
});

test('runtime close flushes users before destroying the database connection', async () => {
	await clear();
	resources.noteCharts.users.update({ host: 'remote.test' }, true);
	await resources.close();
	const db = createDataSource(database.config.database);
	await db.initialize();
	try {
		expect(await db.getRepository(noteChartSchemas.users.hour).find()).toMatchObject([{ ___remote_total: 1 }]);
	} finally {
 await db.destroy(); 
}
});
