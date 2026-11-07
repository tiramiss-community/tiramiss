/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MetricsTime, Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../modules/queue/public.js';
import { baseQueueOptions, onConnectionEnd } from './connection.js';
import type { QueueAdministration, QueueJob, QueueName } from '../../modules/queue/public.js';
import type { RedisConfig } from '../../config/types.js';
import type { Logger } from '../logger.js';

function snapshot(job: QueueJob): QueueJob {
	return {
		id: job.id, name: job.name, data: job.data, opts: job.opts, timestamp: job.timestamp, processedOn: job.processedOn,
		processedBy: job.processedBy, finishedOn: job.finishedOn, progress: job.progress, attemptsMade: job.attemptsMade,
		delay: job.delay, failedReason: job.failedReason, stacktrace: job.stacktrace, returnvalue: job.returnvalue
	};
}

export async function openQueueAdministration(options: { redis: RedisConfig; connectTimeoutMs: number; logger: Logger; onLost(queue: string): void }) {
	const queues = new Map<QueueName, Queue>();
	let closing = false;
	let lost: string | undefined;
	let closePromise: Promise<void> | undefined;
	const close = () => closePromise ??= (async () => {
		closing = true;
		const results = await Promise.allSettled([...queues.values()].map(queue => queue.close()));
		const failed = results.filter(result => result.status === 'rejected');
		if (failed.length) {
			throw new AggregateError(failed.map(result => result.reason), 'QUEUE_ADMIN_CLOSE_FAILED');
		}
	})();
	try {
		for (const name of QUEUE_NAMES) {
			const config = baseQueueOptions(options.redis, name, options.connectTimeoutMs);
			const queue = new Queue(name, { ...config, connection: { ...config.connection, connectionName: `${options.redis.prefix}:queue-admin:${name}` } });
			queues.set(name, queue);
			queue.on('error', error => options.logger.error('queue-admin.redis-error', { queue: name, error }));
			await queue.waitUntilReady();
			await onConnectionEnd(queue, () => {
				if (!closing) {
					lost ??= name;
					options.onLost(name);
				}
			});
		}
		if (lost) {
			throw new Error('Queue administration connection lost during startup');
		}
	} catch (error) {
		await close();
		throw error;
	}
	const get = (name: QueueName) => queues.get(name)!;
	const administration: QueueAdministration = {
		async job(name, id) {
			const job = await get(name).getJob(id);
			return job ? snapshot(job) : null;
		},
		async jobs(name, states, end) {
			return (await get(name).getJobs([...states], 0, end ?? -1)).map(snapshot);
		},
		async logs(name, id) {
			return (await get(name).getJobLogs(id)).logs;
		},
		counts: name => get(name).getJobCounts(),
		async overview(name) {
			const queue = get(name);
			const counts = await queue.getJobCounts();
			const isPaused = await queue.isPaused();
			const completed = await queue.getMetrics('completed', 0, MetricsTime.ONE_WEEK);
			const failed = await queue.getMetrics('failed', 0, MetricsTime.ONE_WEEK);
			return { name, counts, isPaused, metrics: { completed, failed } };
		},
		async backend(name) {
			const queue = get(name);
			return { qualifiedName: queue.qualifiedName, info: await (await queue.getBackend().client).info() };
		},
		async clear(name, state) {
			const queue = get(name);
			if (state === '*') {
				await Promise.all((['completed', 'wait', 'active', 'paused', 'prioritized', 'delayed', 'failed'] as const).map(s => queue.clean(0, 0, s)));
			} else {
				await queue.clean(0, 0, state);
			}
		},
		async promoteJobs(name) {
			await get(name).promoteJobs();
		},
		async pause(name) {
			await get(name).pause();
		},
		async resume(name) {
			await get(name).resume();
		},
		async retryJob(name, id) {
			const job = await get(name).getJob(id);
			if (job) {
				if (job.finishedOn != null) {
					await job.retry();
				} else {
					await job.promote();
				}
			}
		},
		async removeJob(name, id) {
			const job = await get(name).getJob(id);
			if (job) {
				await job.remove();
			}
		},
	};
	return { ...administration, close };
}
