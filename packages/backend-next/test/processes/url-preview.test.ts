/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer, request } from 'node:http';
import { MiMeta } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiMeta).insert({ id: 'singleton' });
});
afterAll(async () => {
	await source?.destroy(); await database?.close(); 
});

test.each([false, true])('built HTTP drains accepted preview and releases resources on SIGTERM (disconnected=%s)', async disconnected => {
	let release!: () => void;
	let entered!: () => void;
	const arrived = new Promise<void>(resolve => {
		entered = resolve; 
	});
	const peer = createServer((_request, response) => {
		release = () => {
			if (!response.headersSent) {
				response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: 'https://result.test', player: { url: null }, title: 'drained' })); 
			} 
		};
		entered();
	});
	await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
	await source.getRepository(MiMeta).update('singleton', { urlPreviewSummaryProxyUrl: `http://127.0.0.1:${(peer.address() as AddressInfo).port}/summary` });
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 10000 } });
	const child = launch('built/entrypoints/http.js', config.path);
	let req: ReturnType<typeof request> | undefined;
	try {
		await child.ready;
		let exited = false; void child.exit.then(() => {
			exited = true; 
		});
		const result = new Promise<number | 'disconnected'>(resolve => {
			req = request(`http://127.0.0.1:${port}/url?url=held`, response => {
				response.resume(); response.once('end', () => resolve(response.statusCode!)); 
			});
			req.once('error', () => resolve('disconnected')); req.end();
		});
		await arrived;
		if (disconnected) {
			req!.destroy();
		}
		child.child.kill('SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 100)); expect(exited).toBe(false);
		release();
		expect(await result).toBe(disconnected ? 'disconnected' : 200);
		expect(await child.exit, child.output()).toEqual({ code: 0, signal: null });
	} finally {
		req?.destroy(); release?.(); await child.close(); await config.close();
		peer.closeAllConnections(); await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
	}
});
