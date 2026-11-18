/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiMeta, MiNote, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createNoteCharts } from '../../src/modules/chart/public.js';
import { createNoteChartStore } from '../../src/platform/database/chart/store.js';
import { noteChartSchemas } from '../../src/platform/database/chart/schema.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
const codec = createIdCodec('aidx');
const token = 'notechartuser001';
let userId: string;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('note-chart-test', () => {}));
	userId = codec.newId(Date.now() - 100000);
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'none' });
	await resources.dataSource.getRepository(MiUser).insert({ id: userId, username: 'chartuser', usernameLower: 'chartuser', token });
});
afterAll(async () => {
	await resources?.close();
	await database?.close();
});

async function clear() {
	for (const spans of Object.values(noteChartSchemas)) {
		for (const schema of Object.values(spans)) {
			await resources.dataSource.getRepository(schema).clear();
		}
	}
}

test('generated metadata matches the inherited migration schema without DDL', async () => {
	await assertSchemaMatches(database.config.database);
});

test('real notes/create and notes/delete reach chart APIs only after flush, including specified asymmetry', async () => {
	await clear();
	const app = createBackendHttpApp(resources, database.config);
	const call = (path: string, input: object) => app.request('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, ...input }) });
	const created = await call('notes/create', { text: 'chart integration', localOnly: true });
	expect(created.status).toBe(200);
	const { createdNote } = await created.json() as { createdNote: { id: string } };
	await resources.notePostSave.idle();
	const read = async (user = false) => {
		const response = await app.request(`/api/charts/${user ? 'user/' : ''}notes?span=hour&limit=1${user ? '&userId=' + userId : ''}`);
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
		return await response.json() as any;
	};
	expect((await read()).local.total).toEqual([0]);
	await resources.noteCharts.flush();
	expect((await read()).local.total).toEqual([1]);
	expect((await read(true)).total).toEqual([1]);
	const deleted = await call('notes/delete', { noteId: createdNote.id });
	expect(deleted.status).toBe(204);
	await resources.notePostDelete.idle();
	await resources.noteCharts.flush();
	expect((await read()).local).toMatchObject({ total: [0], inc: [1], dec: [1] });
	expect((await read(true)).total).toEqual([0]);
	const specified = await call('notes/create', { text: 'private chart', visibility: 'specified', localOnly: true });
	expect(specified.status).toBe(200);
	const specifiedId = (await specified.json() as any).createdNote.id;
	await resources.notePostSave.idle();
	await resources.noteCharts.flush();
	expect((await read()).local.total).toEqual([1]);
	expect((await read(true)).total).toEqual([0]);
	await call('notes/delete', { noteId: specifiedId });
	await resources.notePostDelete.idle();
	await resources.noteCharts.flush();
	expect((await read(true)).total).toEqual([-1]);
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: specifiedId })).toBe(false);
});

test('independent clients race first creation safely and increment existing histories with clamping', async () => {
	await clear();
	const db = createDataSource(database.config.database);
	await db.initialize();
	const redis = new Redis({ host: database.config.redis.host, port: database.config.redis.port, keyPrefix: database.config.redis.keyPrefix });
	try {
		const now = Date.UTC(2026, 10, 18, 12, 50);
		const hour = Math.floor(now / 3600000) * 3600;
		const local = createNoteCharts(createNoteChartStore(resources.dataSource, resources.redis), () => now);
		const peer = createNoteCharts(createNoteChartStore(db, redis), () => now);
		const note = { userId, userHost: 'remote.test', visibility: 'public', replyId: 'reply', renoteId: 'renote', fileIds: ['f'] };
		for (const client of [local, peer]) {
			client.update(note, true, true);
		}
		await Promise.all([local.flush(), peer.flush()]);
		for (const span of ['hour', 'day'] as const) {
			const rows = await db.getRepository(noteChartSchemas.notes[span]).find();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ ___remote_total: 2, ___remote_diffs_reply: 2, ___remote_diffs_renote: 2, ___remote_diffs_withFile: 2 });
			await db.getRepository(noteChartSchemas.notes[span]).update({ id: rows[0].id }, { ___remote_total: 2147483647, ___remote_diffs_normal: -2147483648 });
		}
		local.update({ ...note, replyId: null, renoteId: null }, true, false);
		await local.flush();
		expect((await db.getRepository(noteChartSchemas.notes.hour).findOneByOrFail({ date: hour })).___remote_total).toBe(2147483647);
		local.update({ ...note, replyId: null, renoteId: null }, false, false);
		await local.flush();
		expect((await db.getRepository(noteChartSchemas.notes.hour).findOneByOrFail({ date: hour })).___remote_diffs_normal).toBe(-2147483648);
		const later = createNoteCharts(createNoteChartStore(db, redis), () => now + 3 * 3600000);
		later.update({ ...note, userHost: null }, true, false);
		await later.flush();
		const chart = await later.read('notes', 'hour', 4, null, null) as any;
		expect(chart.remote.inc).toEqual([0, 0, 0, 3]);
		expect(chart.local.inc).toEqual([1, 0, 0, 0]);
		const user = await later.read('perUserNotes', 'hour', 4, null, userId) as any;
		expect(user.total).toEqual([3, 2, 2, 2]);
	} finally {
		await redis.quit();
		await db.destroy();
	}
});

test('per-user smallint arithmetic clamps at both limits without blocking future flushes', async () => {
	await clear();
	const charts = createNoteCharts(createNoteChartStore(resources.dataSource, resources.redis), () => Date.UTC(2026, 10, 18, 12));
	const note = { userId, userHost: null, visibility: 'public', replyId: null, renoteId: null, fileIds: [] };
	charts.update(note, true, false);
	await charts.flush();
	for (const span of ['hour', 'day'] as const) {
		await resources.dataSource.getRepository(noteChartSchemas.perUserNotes[span]).update({ group: userId }, { ___inc: 32767, ___diffs_normal: -32768 });
	}
	charts.update(note, true, false);
	await charts.flush();
	charts.update(note, false, false);
	await charts.flush();
	for (const span of ['hour', 'day'] as const) {
		expect(await resources.dataSource.getRepository(noteChartSchemas.perUserNotes[span]).findOneByOrFail({ group: userId })).toMatchObject({ ___inc: 32767, ___total: 1, ___diffs_normal: -32768 });
	}
});

test('a rejected day UPDATE can leave the hour committed and the failed buffer is discarded', async () => {
	await clear();
	const charts = createNoteCharts(createNoteChartStore(resources.dataSource, resources.redis), () => Date.UTC(2026, 10, 18, 12));
	const db = resources.dataSource;
	await db.query(`CREATE FUNCTION reject_chart_day_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected day update failure'; END $$`);
	await db.query(`CREATE TRIGGER reject_chart_day BEFORE UPDATE ON __chart_day__notes FOR EACH ROW EXECUTE FUNCTION reject_chart_day_update()`);
	try {
		charts.update({ userId, userHost: null, visibility: 'specified', replyId: null, renoteId: null, fileIds: [] }, true, false);
		await expect(charts.flush()).rejects.toThrow('Note chart flush failed');
		expect(await db.getRepository(noteChartSchemas.notes.hour).find()).toMatchObject([{ ___local_total: 1 }]);
		expect(await db.getRepository(noteChartSchemas.notes.day).find()).toMatchObject([{ ___local_total: 0 }]);
	} finally {
		await db.query('DROP TRIGGER reject_chart_day ON __chart_day__notes');
		await db.query('DROP FUNCTION reject_chart_day_update()');
	}
	await charts.flush();
	expect(await db.getRepository(noteChartSchemas.notes.day).find()).toMatchObject([{ ___local_total: 0 }]);
});

test('a failed day claim does not apply either span and discarded changes are not replayed', async () => {
	await clear();
	const store = createNoteChartStore(resources.dataSource, resources.redis);
	const charts = createNoteCharts(store, () => Date.UTC(2026, 10, 18, 12));
	const day = resources.dataSource.getRepository(noteChartSchemas.notes.day);
	const failed = vi.spyOn(day, 'findOneBy').mockRejectedValueOnce(new Error('day claim unavailable'));
	charts.update({ userId, userHost: null, visibility: 'specified', replyId: null, renoteId: null, fileIds: [] }, true, false);
	try {
		await expect(charts.flush()).rejects.toThrow('Note chart flush failed');
	} finally {
		failed.mockRestore();
	}
	const hours = await resources.dataSource.getRepository(noteChartSchemas.notes.hour).find();
	expect(hours).toMatchObject([{ ___local_total: 0, ___local_inc: 0 }]);
	expect(await day.find()).toEqual([]);
	await charts.flush();
	expect(await day.find()).toEqual([]);
	charts.update({ userId, userHost: null, visibility: 'specified', replyId: null, renoteId: null, fileIds: [] }, true, false);
	await charts.flush();
	expect(await day.find()).toMatchObject([{ ___local_total: 1, ___local_inc: 1 }]);
});

test('unlock failure is diagnostic and does not lose claimed hour/day deltas', async () => {
	await clear();
	const report = vi.fn();
	const charts = createNoteCharts(createNoteChartStore(resources.dataSource, resources.redis, report), () => Date.UTC(2026, 10, 18, 12));
	const unlock = vi.spyOn(resources.redis, 'eval').mockRejectedValueOnce(new Error('unlock unavailable'));
	try {
		charts.update({ userId, userHost: null, visibility: 'specified', replyId: null, renoteId: null, fileIds: [] }, true, false);
		await charts.flush();
		expect(report).toHaveBeenCalledTimes(1);
		for (const span of ['hour', 'day'] as const) {
			expect(await resources.dataSource.getRepository(noteChartSchemas.notes[span]).find()).toMatchObject([{ ___local_total: 1, ___local_inc: 1 }]);
		}
	} finally {
		unlock.mockRestore();
		const now = Date.UTC(2026, 10, 18, 12);
		await resources.redis.del(`lock:chart-insert:notes:${Math.floor(now / 3600000) * 3600}:hour`, `lock:chart-insert:notes:${Math.floor(now / 86400000) * 86400}:day`);
	}
});

test('an unresolved unlock does not delay committed hour/day counters', async () => {
	await clear();
	const now = Date.UTC(2026, 10, 18, 12);
	const charts = createNoteCharts(createNoteChartStore(resources.dataSource, resources.redis), () => now);
	const unlock = vi.spyOn(resources.redis, 'eval').mockImplementationOnce(() => new Promise(() => {}));
	try {
		charts.update({ userId, userHost: null, visibility: 'specified', replyId: null, renoteId: null, fileIds: [] }, true, false);
		await charts.flush();
		for (const span of ['hour', 'day'] as const) {
			expect(await resources.dataSource.getRepository(noteChartSchemas.notes[span]).find()).toMatchObject([{ ___local_total: 1 }]);
		}
	} finally {
		unlock.mockRestore();
		await resources.redis.del(`lock:chart-insert:notes:${Math.floor(now / 3600000) * 3600}:hour`, `lock:chart-insert:notes:${Math.floor(now / 86400000) * 86400}:day`);
	}
});

test('deletion uses the persisted note host for global metrics and the author host for per-user eligibility', async () => {
	await clear();
	const id = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiNote).insert({ id, userId, userHost: 'historic.remote', visibility: 'specified', text: 'host history', localOnly: true });
	const app = createBackendHttpApp(resources, database.config);
	const response = await app.request('/api/notes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, noteId: id }) });
	expect(response.status).toBe(204);
	await resources.notePostDelete.idle();
	await resources.noteCharts.flush();
	expect(await resources.dataSource.getRepository(noteChartSchemas.notes.hour).find()).toMatchObject([{ ___remote_total: -1, ___local_total: 0 }]);
	expect(await resources.dataSource.getRepository(noteChartSchemas.perUserNotes.hour).find()).toMatchObject([{ group: userId, ___total: -1 }]);
});

test('resource close drains accepted posting work and flushes before disconnecting PostgreSQL', async () => {
	await clear();
	const app = createBackendHttpApp(resources, database.config);
	const response = await app.request('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, text: 'shutdown', localOnly: true }) });
	expect(response.status).toBe(200);
	await resources.close();
	const db = createDataSource(database.config.database);
	await db.initialize();
	try {
		expect(await db.getRepository(noteChartSchemas.notes.hour).find()).toMatchObject([{ ___local_total: 1, ___local_inc: 1 }]);
	} finally {
		await db.destroy();
	}
});
