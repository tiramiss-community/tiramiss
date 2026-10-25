/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { request } from 'node:http';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiModerationLog, MiRole } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateTestDatabase as migrateDatabase } from '../helpers/database.js';
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

test.each([false, true])('commits an accepted HTTP update once during shutdown (clientDisconnected=%s)', async disconnected => {
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const child = launch('built/entrypoints/http.js', config.path);
	const blocker = source.createQueryRunner();
	let req: ReturnType<typeof request> | undefined;
	try {
		await child.ready;
		const show = await fetch(`http://127.0.0.1:${port}/api/admin/roles/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seeded.actors.root.token}` }, body: JSON.stringify({ roleId: seeded.roleId }) });
		expect(show.status).toBe(200);
		const before = await source.getRepository(MiModerationLog).count();
		const name = `drained-${disconnected}`;
		await blocker.startTransaction();
		await blocker.query('SELECT id FROM role WHERE id = $1 FOR UPDATE', [seeded.roleId]);
		const result = new Promise<number | 'disconnected'>(resolve => {
			req = request({ hostname: '127.0.0.1', port, path: '/api/admin/roles/update', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
				response.resume();
				response.on('end', () => resolve(response.statusCode!));
			});
			req.on('error', () => resolve('disconnected'));
			req.end(JSON.stringify({ roleId: seeded.roleId, name, i: seeded.actors.root.token }));
		});
		await vi.waitFor(async () => {
			const waiting = await source.query('SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\' AND query LIKE \'%FOR UPDATE%\'');
			expect(waiting.length).toBe(1);
		}, { timeout: 5000 });
		if (disconnected) {
			req!.destroy();
		}
		child.child.kill('SIGTERM');
		await blocker.commitTransaction();
		expect(await result).toBe(disconnected ? 'disconnected' : 204);
		expect((await child.exit).code, child.output()).toBe(0);
		expect((await source.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId })).name).toBe(name);
		expect(await source.getRepository(MiModerationLog).count()).toBe(before + 1);
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

test('normal HTTP process consumes DB-volume observation before admitting mutations while keeping reads available', async () => {
	const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { seedHealthyCapacity } = await import('../helpers/database.js');
	const directory = await mkdtemp(join(tmpdir(), 'capacity-http-'));
	const file = join(directory, 'volume.json');
	await writeFile(file, JSON.stringify({ volumeId: 'dedicated-test-volume', observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '1' }));
	const port = await freePort();
	const config = await configuration({ ...database.config, capacityMonitor: { file, volumeId: 'dedicated-test-volume' }, http: { port } });
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		const request = (operation: string, value: object) => fetch(`http://127.0.0.1:${port}/api/admin/roles/${operation}`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
		});
		expect((await request('show', { roleId: seeded.roleId, i: seeded.actors.root.token })).status).toBe(200);
		const before = await source.getRepository(MiModerationLog).count();
		const rejected = await request('update', { roleId: seeded.roleId, name: 'physical-rejected', i: seeded.actors.root.token });
		expect(rejected.status).toBe(503);
		expect((await rejected.json()).error.code).toBe('BACKEND_BUSY');
		expect(await source.getRepository(MiModerationLog).count()).toBe(before);
		await seedHealthyCapacity(source);
		expect((await request('update', { roleId: seeded.roleId, name: 'physical-recovered', i: seeded.actors.root.token })).status).toBe(204);
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
	} finally {
		await child.close();
		await config.close();
		await rm(directory, { recursive: true });
	}
});
