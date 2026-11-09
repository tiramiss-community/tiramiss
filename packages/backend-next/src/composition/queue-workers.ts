/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiWebhook } from 'backend-upstream/entities';
import { createOutboundHttpClient } from './outbound-http.js';
import { createUserWebhookProcessor, startUserWebhookWorker } from '../platform/job-queue/user-webhook.js';
import { createDeliverJobHandler } from './deliver-job.js';
import { createPollEndedHandler } from './poll-ended-job.js';
import { startDeliverWorker } from '../platform/job-queue/deliver.js';
import { startPollEndedWorker } from '../platform/job-queue/ended-poll-notification.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
import type { QueueName } from '../modules/queue/public.js';

export type WorkerStop = () => Promise<void>;
export type WorkerStarter = { readonly name: QueueName; readonly start: () => Promise<WorkerStop> };

export function createQueueWorkers(resources: RuntimeResources, config: RuntimeConfig, reportFailure: (error: Error) => void): readonly WorkerStarter[] {
	const connection = { redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs, logger: resources.logger };
	return [
		{ name: 'endedPollNotification', start: async () => {
			return await startPollEndedWorker({ ...connection, handle: createPollEndedHandler(resources, config), reportFailure });
		} },
		{ name: 'userWebhookDeliver', start: async () => {
			const webhook = createUserWebhookProcessor({
				send: createOutboundHttpClient(config).send, url: config.url,
				update: async (id, status) => {
					await resources.dataSource.manager.getRepository(MiWebhook).update({ id }, { latestSentAt: new Date(), latestStatus: status });
				},
				report: error => resources.logger.error('webhook.status-update-failed', { error }),
			});
			const stopWebhook = await startUserWebhookWorker({ ...connection, process: webhook.process, reportFailure });
			return async () => {
				await stopWebhook(); await webhook.idle();
			};
		} },
		{ name: 'deliver', start: async () => {
			const deliver = createDeliverJobHandler(resources, config);
			const stopDeliver = await startDeliverWorker({
				...connection,
				config: { deliverJobConcurrency: config.outboundHttp.deliverJobConcurrency, deliverJobPerSec: config.deliverJob.deliverJobPerSec },
				process: deliver.process,
				reportFailure,
			});
			return async () => {
				await stopDeliver();
				await deliver.idle();
			};
		} },
	];
}
