/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { QueueEvents } from 'bullmq';
import { baseQueueOptions, onConnectionEnd } from './job-queue/connection.js';
import type { RedisConfig } from '../config/types.js';
import type { QueueCounts, QueueStatsSample, QueueStatsReader } from '../modules/queue/public.js';
import type { Logger } from './logger.js';

type ObservedQueue = 'deliver' | 'inbox';

export function createQueueStats(ports: {
	counts(queue: ObservedQueue): Promise<QueueCounts>;
	subscribeActive(listener: (queue: ObservedQueue) => void): () => void;
	onError(error: unknown): void;
}) {
	const listeners = new Set<(sample: QueueStatsSample) => void>();
	const history: QueueStatsSample[] = [];
	const active = { deliver: 0, inbox: 0 };
	const pending = new Set<Promise<void>>();
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const unsubscribe = ports.subscribeActive(queue => {
		active[queue]++;
	});
	const tick = () => {
		if (closing) {
			return;
		}
		const task = (async () => {
			const deliver = await ports.counts('deliver');
			const inbox = await ports.counts('inbox');
			if (closing) {
				return;
			}
			const sample: QueueStatsSample = {
				deliver: { activeSincePrevTick: active.deliver, active: deliver.active, waiting: deliver.waiting, delayed: deliver.delayed },
				inbox: { activeSincePrevTick: active.inbox, active: inbox.active, waiting: inbox.waiting, delayed: inbox.delayed },
			};
			for (const listener of listeners) {
				listener(sample);
			}
			history.unshift(sample);
			if (history.length > 200) {
				history.pop();
			}
			active.deliver = 0;
			active.inbox = 0;
		})().catch(ports.onError);
		pending.add(task);
		void task.then(() => pending.delete(task), () => pending.delete(task));
	};
	tick();
	const timer = setInterval(tick, 10000);
	return {
		subscribe(listener: (sample: QueueStatsSample) => void) {
			if (!closing) {
				listeners.add(listener);
			} return () => {
				listeners.delete(listener);
			};
		},
		readLog(length: number) {
			return history.slice(0, length);
		},
		close(): Promise<void> {
			return closePromise ??= (async () => {
				closing = true;
				clearInterval(timer);
				unsubscribe();
				listeners.clear();
				while (pending.size) {
					await Promise.allSettled([...pending]);
				}
			})();
		},
	};
}

export async function openQueueStats(options: {
	redis: RedisConfig; connectTimeoutMs: number; logger: Logger;
	counts(queue: ObservedQueue): Promise<QueueCounts>;
	onLost(queue: string): void;
}): Promise<QueueStatsReader & { close(): Promise<void> }> {
	const events = new Map<ObservedQueue, QueueEvents>();
	let closing = false;
	let lost = false;
	let sampler: ReturnType<typeof createQueueStats> | undefined;
	let closePromise: Promise<void> | undefined;
	const close = () => closePromise ??= (async () => {
		closing = true;
		await sampler?.close();
		const results = await Promise.allSettled([...events.values()].map(event => event.close()));
		const failures = results.filter(result => result.status === 'rejected');
		if (failures.length) {
			throw new AggregateError(failures.map(result => result.reason), 'QUEUE_STATS_CLOSE_FAILED');
		}
	})();
	try {
		for (const name of ['deliver', 'inbox'] as const) {
			const event = new QueueEvents(name, { ...baseQueueOptions(options.redis, name, options.connectTimeoutMs), autorun: false });
			events.set(name, event);
			event.on('error', error => options.logger.error('queue-stats.redis-error', { queue: name, error }));
			await event.waitUntilReady();
			await onConnectionEnd(event, () => {
				if (!closing) {
					lost = true; options.onLost(`${name}:events`);
				}
			});
		}
		sampler = createQueueStats({
			counts: options.counts,
			subscribeActive(listener) {
				const deliver = () => listener('deliver');
				const inbox = () => listener('inbox');
				events.get('deliver')!.on('active', deliver);
				events.get('inbox')!.on('active', inbox);
				return () => {
					events.get('deliver')!.off('active', deliver); events.get('inbox')!.off('active', inbox);
				};
			},
			onError: error => options.logger.error('queue-stats.sample-failed', { error }),
		});
		for (const [name, event] of events) {
			void event.run().then(() => {
				if (!closing) {
					options.onLost(`${name}:events`);
				}
			}, error => {
				if (!closing) {
					options.logger.error('queue-stats.events-failed', { queue: name, error }); options.onLost(`${name}:events`);
				}
			});
		}
		if (lost) {
			throw new Error('Queue statistics connection lost during startup');
		}
		return { subscribe: sampler.subscribe, readLog: sampler.readLog, close };
	} catch (error) {
		await close(); throw error;
	}
}
