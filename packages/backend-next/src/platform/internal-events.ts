/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import type { RedisConfig } from '../config/types.js';

export interface InternalEvent {
	type: string;
	body: Record<string, unknown>;
}
interface Handlers {
	onInternal?(event: InternalEvent): void | Promise<void>;
	onRoleChange?(event: Record<string, unknown>): void | Promise<void>;
	/** Raw Redis ready, before subscription acknowledgement (webhook W1). */
	onReady?(): void;
	onLost?(): void;
}
export type InternalEvents = Awaited<ReturnType<typeof openInternalEvents>>;
export const roleMaterialTopic = (prefix: string) => `${prefix}:backend-next:role-materials:v1`;

function eventRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Process-owned transport. Consumers own cache policy and unregister independently. */
export async function openInternalEvents(options: {
	subscriberConfig: RedisConfig;
	url?: string;
	privateRoleTopic?: string;
	timeoutMs?: number;
	onError(error: unknown): void;
	registerCleanup?(cleanup: () => Promise<void>): void;
}) {
	const host = options.url ? new URL(options.url).host : undefined;
	const topics = [...new Set([host, options.privateRoleTopic].filter((topic): topic is string => topic !== undefined))];
	if (topics.length === 0) {
		throw new Error('Internal event receiver requires a topic');
	}
	const subscriber = new Redis({
		...options.subscriberConfig,
		...(options.timeoutMs === undefined ? {} : { connectTimeout: options.timeoutMs }),
		lazyConnect: true, enableOfflineQueue: false, autoResubscribe: false,
		disconnectTimeout: 0, maxRetriesPerRequest: 0,
		retryStrategy: attempt => Math.min(attempt * 100, 1000),
	});
	const handlers = new Set<Handlers>();
	let closed = false;
	let subscribed = false;
	let generation = 0;
	let initial = true;
	let readyOnce = false;
	const report = (error: unknown) => {
		try {
			options.onError(error);
		} catch { /* Diagnostics cannot interrupt another consumer. */ }
	};
	const invoke = (run: () => void | Promise<void>) => {
		try {
			void Promise.resolve(run()).catch(report);
		} catch (error) {
			report(error);
		}
	};
	const lost = () => {
		generation++;
		subscribed = false;
		for (const handler of handlers) {
			if (handler.onLost) {
				invoke(handler.onLost);
			}
		}
	};
	const subscribe = async () => {
		lost();
		const current = generation;
		await subscriber.subscribe(...topics);
		if (!closed && current === generation && subscriber.status === 'ready') {
			subscribed = true;
		}
	};
	const ready = () => {
		readyOnce = true;
		for (const handler of handlers) {
			if (handler.onReady) {
				invoke(handler.onReady);
			}
		}
		if (!initial && !closed) {
			void subscribe().catch(report);
		}
	};
	const receive = (topic: string, payload: string) => {
		if (closed || !topics.includes(topic)) {
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(payload);
		} catch {
			return;
		}
		if (!eventRecord(value)) {
			return;
		}
		if (topic === host && value.channel === 'internal' && eventRecord(value.message)
			&& typeof value.message.type === 'string' && eventRecord(value.message.body)) {
			const event = { type: value.message.type, body: value.message.body };
			for (const handler of handlers) {
				if (handler.onInternal) {
					invoke(() => handler.onInternal!(structuredClone(event)));
				}
			}
		}
		if (topic === options.privateRoleTopic && value.kind === 'role-definitions-changed') {
			for (const handler of handlers) {
				if (handler.onRoleChange) {
					invoke(() => handler.onRoleChange!(structuredClone(value)));
				}
			}
		}
	};
	subscriber.on('message', receive);
	subscriber.on('ready', ready);
	subscriber.on('close', lost);
	subscriber.on('error', report);
	let closing: Promise<void> | undefined;
	const close = () => {
		if (closing) {
			return closing;
		}
		closed = true;
		lost();
		handlers.clear();
		subscriber.off('message', receive);
		subscriber.off('ready', ready);
		subscriber.off('close', lost);
		closing = subscriber.status === 'end' ? Promise.resolve() : new Promise<void>(resolve => {
			subscriber.once('end', resolve);
			subscriber.disconnect();
		});
		return closing;
	};
	options.registerCleanup?.(close);
	try {
		await subscriber.connect();
		if (!closed) {
			await subscribe();
		}
		initial = false;
	} catch (error) {
		await close();
		throw error;
	}
	return {
		register(handler: Handlers) {
			if (closed) {
				return () => {};
			}
			handlers.add(handler);
			// Consumers added after transport startup still observe the initial ready.
			if (readyOnce && subscriber.status === 'ready' && handler.onReady) {
				invoke(handler.onReady);
			}
			return () => {
				handlers.delete(handler);
			};
		},
		available: () => !closed && subscribed && subscriber.status === 'ready',
		generation: () => generation,
		close,
	};
}
