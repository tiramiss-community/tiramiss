/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { UnrecoverableError } from 'bullmq';
import { OutboundStatusError } from '../../application/outbound-http.js';
import type { JobHandler } from '@mokurokujs/core';
import type { OutboundSend } from '../../application/outbound-http.js';
import type { Logger } from '../logger.js';

export const USER_WEBHOOK_DELIVER = 'userWebhookDeliver';
export type UserWebhookEvent = 'note' | 'reply' | 'renote' | 'mention';
export interface UserWebhookTarget { id: string; userId: string; url: string; secret: string }
export interface UserWebhookJob { webhookId: string; userId: string; to: string; secret: string; type: UserWebhookEvent; content: { note: Record<string, unknown> }; createdAt: number; eventId: string }
export type StoredUserWebhookJob = Omit<UserWebhookJob, 'type' | 'content'> & (
	| { type: UserWebhookEvent; content: { note: Record<string, unknown> } }
	| { type: 'follow' | 'unfollow' | 'followed'; content: { user: Record<string, unknown> } }
);

export function userWebhookJob(hook: UserWebhookTarget, type: UserWebhookEvent, content: UserWebhookJob['content'], createdAt: number, eventId: string) {
	return {
		name: hook.id,
		data: { webhookId: hook.id, userId: hook.userId, to: hook.url, secret: hook.secret, type, content, createdAt, eventId },
		opts: { attempts: 4, backoff: { type: 'custom' as const }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } },
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
		async process(job: StoredUserWebhookJob): Promise<string> {
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

export function createUserWebhookJobProcessor(process: (job: StoredUserWebhookJob) => Promise<string>, logger: Logger): JobHandler<StoredUserWebhookJob, string> {
	return async (payload, context) => {
		try {
			return await process(payload);
		} catch (error) {
			logger.error('job.failed', { queue: USER_WEBHOOK_DELIVER, jobId: context.jobId, jobName: context.jobName, attemptsMade: context.attempt - 1, errorName: error instanceof Error ? error.name : 'UnknownError' });
			throw error;
		}
	};
}
