/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { OutboundStatusError } from '../../application/outbound-http.js';
import { baseQueueOptions, baseWorkerOptions, onConnectionEnd, runWorker } from './connection.js';
import { httpRelatedBackoff } from './deliver.js';
import type { RedisConfig } from '../../config/types.js';
import type { OutboundSend } from '../../application/outbound-http.js';
import type { Logger } from '../logger.js';

export const USER_WEBHOOK_DELIVER = 'userWebhookDeliver';
export type UserWebhookEvent = 'note' | 'reply' | 'renote' | 'mention';
export interface UserWebhookTarget { id: string; userId: string; url: string; secret: string }
export interface UserWebhookJob { webhookId: string; userId: string; to: string; secret: string; type: UserWebhookEvent; content: { note: Record<string, unknown> }; createdAt: number; eventId: string }
interface Connection { redis: RedisConfig; connectTimeoutMs: number; logger: Logger }

export function userWebhookJob(hook: UserWebhookTarget, type: UserWebhookEvent, content: UserWebhookJob['content'], createdAt: number, eventId: string) {
	return {
		name: hook.id,
		data: { webhookId: hook.id, userId: hook.userId, to: hook.url, secret: hook.secret, type, content, createdAt, eventId },
		opts: { attempts: 4, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } },
	};
}

export function createUserWebhookQueue(options: Connection & { onLost(): void }) {
	const queue = new Queue(USER_WEBHOOK_DELIVER, baseQueueOptions(options.redis, USER_WEBHOOK_DELIVER, options.connectTimeoutMs));
	let closing = false;
	queue.on('error', error => options.logger.error('job-queue.error', { queue: USER_WEBHOOK_DELIVER, error }));
	return {
		async ready() {
			await queue.waitUntilReady();
			await onConnectionEnd(queue, () => {
				if (!closing) {
					options.onLost();
				}
			});
		},
		async enqueue(hook: UserWebhookTarget, type: UserWebhookEvent, note: Record<string, unknown>) {
			const job = userWebhookJob(hook, type, { note }, Date.now(), randomUUID());
			await queue.add(job.name, job.data, job.opts);
		},
		async close() {
			closing = true; await queue.close();
		},
	};
}

export function createUserWebhookProcessor(options: { send: OutboundSend; url: string; update(id: string, status: number): Promise<void>; report(error: unknown): void }) {
	const pending = new Set<Promise<void>>();
	const update = (id: string, status: number) => {
		const work = options.update(id, status).catch(options.report);
		pending.add(work);
		void work.finally(() => pending.delete(work));
	};
	return {
		async process(job: UserWebhookJob): Promise<string> {
			try {
				const response = await options.send(job.to, {
					method: 'POST', headers: { 'User-Agent': 'Misskey-Hooks', 'X-Misskey-Host': new URL(options.url).host, 'X-Misskey-Hook-Id': job.webhookId, 'X-Misskey-Hook-Secret': job.secret, 'Content-Type': 'application/json' },
					body: JSON.stringify({ server: options.url, hookId: job.webhookId, userId: job.userId, eventId: job.eventId, createdAt: job.createdAt, type: job.type, body: job.content }),
				});
				update(job.webhookId, response.status);
				return 'Success';
			} catch (error) {
				update(job.webhookId, error instanceof OutboundStatusError ? error.statusCode : 1);
				if (error instanceof OutboundStatusError) {
					if (!error.isRetryable) {
						throw new UnrecoverableError(`${error.statusCode} ${error.statusMessage}`);
					}
					throw new Error(`${error.statusCode} ${error.statusMessage}`);
				}
				throw error;
			}
		},
		async idle() {
			await Promise.all([...pending]);
		},
	};
}

export function createUserWebhookJobProcessor(process: (job: UserWebhookJob) => Promise<string>, logger: Logger) {
	return async (job: { id?: string; name: string; attemptsMade: number; data: UserWebhookJob }) => {
		try {
			return await process(job.data);
		} catch (error) {
			logger.error('job.failed', { queue: USER_WEBHOOK_DELIVER, jobId: job.id, jobName: job.name, attemptsMade: job.attemptsMade, errorName: error instanceof Error ? error.name : 'UnknownError' });
			throw error;
		}
	};
}

export async function startUserWebhookWorker(options: Connection & { process(job: UserWebhookJob): Promise<string>; reportFailure(error: Error): void }) {
	const worker = new Worker<UserWebhookJob>(USER_WEBHOOK_DELIVER, createUserWebhookJobProcessor(options.process, options.logger), {
		...baseWorkerOptions(options.redis, USER_WEBHOOK_DELIVER, options.connectTimeoutMs), autorun: false,
		concurrency: 64, limiter: { max: 64, duration: 1000 }, settings: { backoffStrategy: attempts => httpRelatedBackoff(attempts) },
	});
	return await runWorker(worker, { queue: USER_WEBHOOK_DELIVER, logger: options.logger, reportFailure: options.reportFailure });
}
