/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer, type Server } from 'node:http';
import { chmod } from 'node:fs/promises';
import { getRequestListener } from '@hono/node-server';
import { createBackendHttpApp } from '../composition/http-app.js';
import { openPostingWebSocket } from '../composition/posting-websocket.js';
import { openQueueHttp } from '../composition/queue-http.js';
import { startManagedProcess } from './lifecycle.js';
import type { Hono } from 'hono';
import type { RuntimeConfig } from '../config/types.js';

interface HttpState {
	draining: boolean;
	active: Set<Promise<void>>;
	drainers: Set<() => Promise<void>>;
}

const states = new WeakMap<Server, HttpState>();

export async function listenHttp(app: Hono, config: RuntimeConfig['http']): Promise<Server> {
	const state: HttpState = { draining: false, active: new Set(), drainers: new Set() };
	const listener = getRequestListener(app.fetch);

	const server: Server = createServer((request, response) => {
		if (state.draining) {
			response.writeHead(503, { Connection: 'close' });
			response.end();
			return;
		}

		response.once('finish', () => {
			// finish の時点ではまだ idle 扱いでないことがある。即時に閉じるだけでは keep-alive が残る。
			if (state.draining) {
				setImmediate(() => {
					server.closeIdleConnections();
				});
			}
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
		if (config.socket) {
			server.listen(config.socket, ready);
		} else {
			server.listen(config.port ?? 3000, ready);
		}
	});

	try {
		if (config.socket && config.chmodSocket) {
			await chmod(config.socket, parseInt(config.chmodSocket, 8));
		}
	} catch (error) {
		await closeHttp(server);
		throw error;
	}

	return server;
}

export function registerHttpDrain(server: Server, drain: () => Promise<void>): void {
	const state = states.get(server);
	if (!state) {
		throw new Error('HTTP server not managed');
	}
	state.drainers.add(drain);
}

export async function closeHttp(server: Server): Promise<void> {
	const state = states.get(server);
	if (!state) {
		throw new Error('HTTP server not managed');
	}

	state.draining = true;
	await Promise.all([
		...Array.from(state.drainers, drain => drain()),
		new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
			server.closeIdleConnections();
		}),
		// 切断しても受理済みの処理は続くため、ソケットだけを待つと処理中に DB を閉じてしまう。
		// 一件の失敗で他の処理の待機まで打ち切らないよう、all ではなく allSettled を使う。
		Promise.allSettled([...state.active]),
	]);
}

export function startHttp(config: RuntimeConfig) {
	return startManagedProcess('http', config, async (resources, reportFailure) => {
		const queues = await openQueueHttp(resources, config, reportFailure);
		let server: Server;
		try {
			server = await listenHttp(createBackendHttpApp(resources, config, queues.api), config.http);
		} catch (error) {
			await queues.close();
			throw error;
		}
		registerHttpDrain(server, queues.stats.close);
		try {
			const streaming = await openPostingWebSocket(server, resources, config, reportFailure, queues.stats);
			registerHttpDrain(server, streaming.close);
		} catch (error) {
			await closeHttp(server);
			await queues.close();
			throw error;
		}
		return async () => {
			try {
				await closeHttp(server);
			} finally {
				await queues.close();
			}
		};
	});
}
