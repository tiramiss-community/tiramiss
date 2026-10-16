/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer, type Server } from 'node:http';
import { chmod } from 'node:fs/promises';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { startManagedProcess } from './lifecycle.js';
import type { RuntimeConfig } from '../config/types.js';
interface HttpState {
	draining: boolean;
	active: Set<Promise<void>>;
}
const states = new WeakMap<Server, HttpState>();
export async function listenHttp(app: Hono, config: RuntimeConfig['http']): Promise<Server> {
	const state: HttpState = { draining: false, active: new Set() };
	const listener = getRequestListener(app.fetch);
	const server: Server = createServer((request, response) => {
		if (state.draining) {
			response.writeHead(503, { Connection: 'close' });
			response.end();
			return;
		}
		response.once('finish', () => {
			// A response can become keep-alive idle after close() starts.
			if (state.draining) setImmediate(() => {
					server.closeIdleConnections();
				});
		});
		const handling = Promise.resolve(listener(request, response));
		state.active.add(handling);
		void handling.then(
			() => {
				state.active.delete(handling);
			},
			(error) => {
				state.active.delete(handling);
				response.destroy(error instanceof Error ? error : undefined);
			},
		);
	});
	states.set(server, state);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		const ready = () => {
			server.off('error', reject);
			resolve();
		};
		if (config.socket) server.listen(config.socket, ready);
		else server.listen(config.port ?? 3000, ready);
	});
	try {
		if (config.socket && config.chmodSocket) await chmod(config.socket, parseInt(config.chmodSocket, 8));
	} catch (error) {
		await closeHttp(server);
		throw error;
	}
	return server;
}
export async function closeHttp(server: Server): Promise<void> {
	const state = states.get(server);
	if (!state) throw new Error('HTTP server not managed');
	state.draining = true;
	await Promise.all([
		new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error);
				else resolve();
			});
			server.closeIdleConnections();
		}),
		// Client disconnect does not imply that the accepted operation has finished.
		Promise.allSettled([...state.active]),
	]);
}
export function startHttp(config: RuntimeConfig) {
	return startManagedProcess('http', config, async () => {
		const server = await listenHttp(new Hono(), config.http);
		return () => closeHttp(server);
	});
}
