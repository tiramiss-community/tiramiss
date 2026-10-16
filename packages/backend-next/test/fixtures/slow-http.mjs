/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { runChild } from '../../built/entrypoints/run-child.js';
import { startManagedProcess } from '../../built/processes/lifecycle.js';
import { listenHttp, closeHttp } from '../../built/processes/http.js';
await runChild('http', (config) =>
	startManagedProcess('http', config, async () => {
		const app = new Hono();
		app.get('/', async (context) => {
			process.send?.({ type: 'request-started' });
			await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_REQUEST_MS ?? 100)));
			process.send?.({ type: 'handler-completed' });
			return context.text('completed');
		});
		const server = await listenHttp(app, config.http);
		return () => closeHttp(server);
	}),
);
