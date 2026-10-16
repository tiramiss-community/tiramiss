/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { request } from 'node:http';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
test('waits for an accepted handler after its HTTP client has disconnected', async () => {
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let completed = false;
	const app = new Hono();
	app.get('/', async (context) => {
		entered();
		await pending;
		completed = true;
		return context.text('done');
	});
	const server = await listenHttp(app, { port: 0 });
	const req = request({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port });
	req.on('error', () => {});
	req.end();
	let closed = false;
	try {
		await started;
		req.destroy();
		const draining = closeHttp(server).then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(completed).toBe(false);
		expect(closed).toBe(false);
		release();
		await draining;
		expect(completed).toBe(true);
	} finally {
		release();
		req.destroy();
		if (server.listening) await closeHttp(server);
	}
});
