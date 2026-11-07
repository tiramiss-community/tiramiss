/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from './diagnostic-error.js';
import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthenticationFailed } from '../http/authentication-error.js';
import { createStreamConnection } from '../modules/stream/public.js';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RedisConfig } from '../config/types.js';
import type { StreamFacts, StreamNote } from '../modules/stream/public.js';
import type { Logger } from './logger.js';
import type { QueueStatsReader } from '../modules/queue/public.js';

export interface StreamingPorts {
	authenticate(token: string | null): Promise<{ userId: string; canReadAccount: boolean; isSuspended: boolean } | null>;
	readFacts(userId: string | null): Promise<StreamFacts>;
	hidingFollowing(userId: string | null): Promise<ReadonlySet<string>>;
	repack(id: string, userId: string | null): Promise<Record<string, unknown> | null>;
	reaction(note: StreamNote, userId: string | null): Promise<string | undefined>;
	touchActivity(userId: string): Promise<void>;
}

export async function openStreamingServer(server: Server, options: {
	redis: RedisConfig;
	selfUrl: string;
	ports: StreamingPorts;
	logger: Logger;
	onFailure(error: Error): void;
	queueStats?: QueueStatsReader;
}) {
	let draining = false;
	const tasks = new Set<Promise<unknown>>();
	const upgrading = new Set<Duplex>();
	const sessions = new Map<WebSocket, { publish(value: unknown): void; dispose(): void; lastPong: number }>();
	const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	const subscriber = new Redis({ ...options.redis, connectionName: `${options.redis.prefix}:posting-stream`, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0, disconnectTimeout: 0 });
	const track = <T>(promise: Promise<T>): Promise<T> => {
		tasks.add(promise);
		void promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
		return promise;
	};
	const background = (promise: Promise<unknown>) => {
		void track(promise).catch(error => options.logger.error('streaming.operation.failed', { error }));
	};
	const reject = (socket: Duplex, status: string, challenge = false) => {
		socket.write(`HTTP/1.1 ${status}\r\n${challenge ? 'WWW-Authenticate: Bearer realm="Misskey", error="invalid_token", error_description="Failed to authenticate"\r\n' : ''}\r\n`);
		socket.destroy();
	};

	const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		upgrading.add(socket);
		const onSocketError = () => socket.destroy();
		const releaseSocket = () => {
 socket.off('error', onSocketError); socket.off('close', releaseSocket); 
};
		// ws takes ownership only after asynchronous authentication and fact reads finish.
		socket.on('error', onSocketError);
		socket.once('close', releaseSocket);
		try {
			if (draining) {
				reject(socket, '503 Service Unavailable');
				return;
			}
			if (!request.url) {
				reject(socket, '400 Bad Request');
				return;
			}
			let query: URLSearchParams;
			try {
				query = new URL(request.url, options.selfUrl).searchParams;
			} catch {
				reject(socket, '400 Bad Request');
				return;
			}
			const authorization = request.headers.authorization;
			const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : query.get('i');
			let actor: Awaited<ReturnType<StreamingPorts['authenticate']>>;
			try {
				actor = await options.ports.authenticate(token);
				if (actor && !actor.canReadAccount) {
					throw new AuthenticationFailed();
				}
			} catch (error) {
				reject(socket, error instanceof AuthenticationFailed ? '401 Unauthorized' : '500 Internal Server Error', error instanceof AuthenticationFailed);
				return;
			}
			if (actor?.isSuspended) {
				reject(socket, '403 Forbidden');
				return;
			}
			const userId = actor?.userId ?? null;
			let facts = await options.ports.readFacts(userId);
			if (draining || socket.destroyed) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(request, socket, head, ws => {
				releaseSocket();
				let closed = false;
				let queue = Promise.resolve();
				const enqueue = (work: () => Promise<void>) => {
					if (closed || draining) {
						return;
					}
					queue = track(queue.then(async () => {
						if (!closed && !draining) {
							await work();
						}
					}).catch(error => options.logger.error('streaming.event.failed', { error })));
				};
				const connection = createStreamConnection({
					facts: () => facts, now: Date.now, hidingFollowing: () => options.ports.hidingFollowing(userId), queueStats: options.queueStats,
					send: value => {
						if (!closed && !draining && ws.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify(value));
						}
					},
					repack: id => options.ports.repack(id, userId), reaction: note => options.ports.reaction(note, userId),
				});
				let refreshing = false;
				const refresh = userId ? setInterval(() => {
					if (!closed && !draining && !refreshing) {
						refreshing = true;
						background(options.ports.readFacts(userId).then(value => {
 facts = value; 
}).finally(() => {
 refreshing = false; 
}));
					}
				}, 10000) : undefined;
				const activity = userId ? setInterval(() => background(options.ports.touchActivity(userId)), 300000) : undefined;
				if (userId) {
					background(options.ports.touchActivity(userId));
				}
				const session = {
					lastPong: Date.now(), publish: (value: unknown) => enqueue(() => connection.publish(value)),
					dispose: () => {
						closed = true;
						connection.dispose();
						clearInterval(refresh);
						clearInterval(activity);
						sessions.delete(ws);
					},
				};
				sessions.set(ws, session);
				ws.on('message', data => {
					let value: unknown;
					try {
						value = JSON.parse(data.toString());
					} catch {
						return;
					}
					enqueue(() => connection.receive(value));
				});
				ws.on('pong', () => {
 session.lastPong = Date.now(); 
});
				ws.on('error', error => options.logger.error('streaming.socket.error', { error }));
				ws.once('close', session.dispose);
			});
		} catch (error) {
			options.logger.error('streaming.upgrade.failed', { error });
			if (!socket.destroyed) {
				reject(socket, '500 Internal Server Error');
			}
		} finally {
			upgrading.delete(socket);
		}
	};
	const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		background(upgrade(request, socket, head));
	};
	const onMessage = (_channel: string, data: string) => {
		let value: unknown;
		try {
			value = JSON.parse(data);
		} catch {
			return;
		}
		for (const session of sessions.values()) {
			session.publish(value);
		}
	};
	subscriber.on('error', error => options.logger.error('streaming.redis.error', { error }));
	subscriber.on('end', () => {
		if (!draining) {
			options.onFailure(new DiagnosticError('POSTING_STREAM_REDIS_ENDED', {}));
		}
	});
	try {
		await subscriber.connect();
		await subscriber.subscribe(new URL(options.selfUrl).host);
	} catch (error) {
		draining = true;
		subscriber.disconnect();
		wss.close();
		throw error;
	}
	subscriber.on('message', onMessage);
	server.on('upgrade', onUpgrade);
	const heartbeat = setInterval(() => {
		for (const [ws, session] of sessions) {
			if (Date.now() - session.lastPong > 120000) {
				ws.terminate();
				session.dispose();
			} else {
				ws.ping();
			}
		}
	}, 60000);

	let closing: Promise<void> | undefined;
	return {
		close(): Promise<void> {
			return closing ??= (async () => {
				draining = true;
				clearInterval(heartbeat);
				for (const socket of upgrading) {
					socket.destroy();
				}
				for (const [ws, session] of sessions) {
					session.dispose();
					ws.terminate();
				}
				subscriber.off('message', onMessage);
				while (tasks.size) {
					await Promise.allSettled([...tasks]);
				}
				await new Promise<void>(resolve => wss.close(() => resolve()));
				subscriber.disconnect();
				// Keep rejecting upgrades until HTTP has stopped listening.
				server.once('close', () => server.off('upgrade', onUpgrade));
			})();
		},
	};
}
