/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { defineJob } from '@mokurokujs/core';
import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { baseQueueOptions, baseWorkerOptions } from './connection.js';
import { DELIVER, deliverJobs, deliverWorkerOptions, httpRelatedBackoff } from './deliver.js';
import { ENDED_POLL_NOTIFICATION, pollEndedJobOptions } from './ended-poll-notification.js';
import { USER_WEBHOOK_DELIVER, userWebhookJob } from './user-webhook.js';
import type { JobDefinition } from '@mokurokujs/core';
import type { BullMQQueueDefinition } from '@mokurokujs/bullmq-adapter';
import type { RedisConfig } from '../../config/types.js';
import type { DeliverJob, DeliverBatch, DeliverOne } from '../../modules/federation/public.js';
import type { PollEndedJob } from './ended-poll-notification.js';
import type { StoredUserWebhookJob, UserWebhookEvent, UserWebhookTarget } from './user-webhook.js';
import type { OwnedBusinessJobRuntime } from './runtime.js';

export type BusinessQueueName = 'endedPollNotification' | 'deliver' | 'userWebhookDeliver';
export interface BusinessJobConfig {
	redis: RedisConfig;
	connectTimeoutMs: number;
	deliverJobMaxAttempts?: number;
	deliverJobConcurrency?: number;
	deliverJobPerSec?: number;
}
export interface BusinessJobDefinitions {
	readonly queues: readonly [BullMQQueueDefinition, BullMQQueueDefinition, BullMQQueueDefinition];
	readonly pollEnded: JobDefinition<PollEndedJob, void>;
	readonly deliver: JobDefinition<DeliverJob, string>;
	readonly userWebhook: JobDefinition<StoredUserWebhookJob, string>;
}
export interface BusinessJobProducers {
	schedulePollEnded(input: { noteId: string; delayMs: number }): Promise<void>;
	deliverMany(batch: DeliverBatch): Promise<void>;
	deliverOne(input: DeliverOne): Promise<void>;
	enqueueWebhook(hook: UserWebhookTarget, type: UserWebhookEvent, note: Record<string, unknown>): Promise<void>;
}

export function createBusinessJobDefinitions(config: BusinessJobConfig): BusinessJobDefinitions {
	const { redis, connectTimeoutMs } = config;
	const poll = defineQueueForBullMQ(ENDED_POLL_NOTIFICATION, {
		queueOptions: baseQueueOptions(redis, ENDED_POLL_NOTIFICATION, connectTimeoutMs),
		workerOptions: { ...baseWorkerOptions(redis, ENDED_POLL_NOTIFICATION, connectTimeoutMs), autorun: false },
	}).build();
	const deliver = defineQueueForBullMQ(DELIVER, {
		queueOptions: baseQueueOptions(redis, DELIVER, connectTimeoutMs),
		workerOptions: deliverWorkerOptions(redis, connectTimeoutMs, config),
	}).build();
	const webhook = defineQueueForBullMQ(USER_WEBHOOK_DELIVER, {
		queueOptions: baseQueueOptions(redis, USER_WEBHOOK_DELIVER, connectTimeoutMs),
		workerOptions: {
			...baseWorkerOptions(redis, USER_WEBHOOK_DELIVER, connectTimeoutMs), autorun: false,
			concurrency: 64, limiter: { max: 64, duration: 1000 }, settings: { backoffStrategy: attempts => httpRelatedBackoff(attempts) },
		},
	}).build();
	return {
		queues: [poll, deliver, webhook],
		pollEnded: defineJob<PollEndedJob, void>(ENDED_POLL_NOTIFICATION, { queue: poll }),
		deliver: defineJob<DeliverJob, string>(DELIVER, { queue: deliver }),
		userWebhook: defineJob<StoredUserWebhookJob, string>(USER_WEBHOOK_DELIVER, { queue: webhook }),
	};
}

export function createBusinessJobProducers(owner: OwnedBusinessJobRuntime, definitions: BusinessJobDefinitions, config: Pick<BusinessJobConfig, 'deliverJobMaxAttempts'>): BusinessJobProducers {
	return {
		async schedulePollEnded(input) {
			owner.assertOpen();
			const { name, data, opts } = pollEndedJobOptions(input);
			await owner.runtime.enqueue(definitions.pollEnded, data, { ...opts, jobName: name });
		},
		async deliverMany(batch) {
			owner.assertOpen();
			await owner.runtime.enqueueBulk(definitions.deliver, deliverJobs(batch, config).map(({ name, data, opts }) => ({ payload: data, options: { ...opts, jobName: name } })));
		},
		async deliverOne(input) {
			owner.assertOpen();
			if (input.activity === null || input.to === null) {
				return;
			}
			const [job] = deliverJobs({ user: { id: input.user.id }, activity: input.activity, inboxes: new Map([[input.to, input.isSharedInbox]]) }, config);
			await owner.runtime.enqueue(definitions.deliver, job.data, { ...job.opts, jobName: job.name });
		},
		async enqueueWebhook(hook, type, note) {
			owner.assertOpen();
			const { name, data, opts } = userWebhookJob(hook, type, { note }, Date.now(), randomUUID());
			await owner.runtime.enqueue(definitions.userWebhook, data, { ...opts, jobName: name });
		},
	};
}
