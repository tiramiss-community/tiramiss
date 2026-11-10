/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiWebhook } from 'backend-upstream/entities';
import { createUserWebhookJobProcessor, createUserWebhookProcessor } from '../platform/job-queue/user-webhook.js';
import { createDeliverProcessor } from '../platform/job-queue/deliver.js';
import { createPollEndedProcessor } from '../platform/job-queue/ended-poll-notification.js';
import { createBusinessJobDefinitions } from '../platform/job-queue/business-jobs.js';
import { createBusinessJobRuntime } from '../platform/job-queue/runtime.js';
import { DiagnosticError } from '../platform/diagnostic-error.js';
import { createDeliverJobHandler } from './deliver-job.js';
import { createPollEndedHandler } from './poll-ended-job.js';
import type { BusinessQueueName } from '../platform/job-queue/business-jobs.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export type WorkerStop = () => Promise<void>;

export async function startQueueWorkers(resources: RuntimeResources, config: RuntimeConfig, reportFailure: (error: Error) => void): Promise<WorkerStop> {
	let active = false;
	let stopping = false;
	let startupFailure: Error | undefined;
	const connection = { redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs };
	const definitions = createBusinessJobDefinitions({
		...connection,
		deliverJobConcurrency: config.outboundHttp.deliverJobConcurrency,
		deliverJobPerSec: config.deliverJob.deliverJobPerSec,
	});
	const owner = createBusinessJobRuntime({
		...connection,
		onError: event => {
			resources.logger.error('job-queue.error', { queue: event.queue, error: event.error });
			if (stopping || event.reason === 'error' || event.reason === 'cleanup') {
				return;
			}
			const code = event.reason === 'connection-ended' ? 'JOB_QUEUE_REDIS_ENDED' : event.reason === 'run-fulfilled' ? 'JOB_WORKER_STOPPED' : 'JOB_WORKER_FAILED';
			const error = new DiagnosticError(code, { queue: event.queue, error: event.error });
			if (active) {
				reportFailure(error);
			} else {
				startupFailure ??= error;
			}
		},
	});
	const drains = new Map<BusinessQueueName, () => Promise<void>>();
	let stopPromise: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		stopping = true;
		return stopPromise ??= (async () => {
			const errors: unknown[] = [];
			try {
				await owner.stop();
			} catch (error) {
				errors.push(error);
			}
			const closed = await owner.closedWorkerQueues();
			const results = await Promise.allSettled([...drains].filter(([queue]) => closed.has(queue)).map(([, idle]) => idle()));
			for (const result of results) {
				if (result.status === 'rejected') {
					errors.push(result.reason);
				}
			}
			if (errors.length) {
				throw new AggregateError(errors, 'Worker stop failed');
			}
		})();
	};

	try {
		const poll = createPollEndedHandler(resources, config);
		const webhook = createUserWebhookProcessor({
			send: resources.outboundHttp.send, url: config.url,
			update: async (id, status) => {
				await resources.dataSource.manager.getRepository(MiWebhook).update({ id }, { latestSentAt: new Date(), latestStatus: status });
			},
			report: error => resources.logger.error('webhook.status-update-failed', { error }),
		});
		drains.set('userWebhookDeliver', webhook.idle);
		const deliver = createDeliverJobHandler(resources, config);
		drains.set('deliver', deliver.idle);
		owner.runtime.handle(definitions.pollEnded, createPollEndedProcessor(poll, resources.logger), { defaultForQueue: true });
		owner.runtime.handle(definitions.userWebhook, createUserWebhookJobProcessor(webhook.process, resources.logger), { defaultForQueue: true });
		owner.runtime.handle(definitions.deliver, createDeliverProcessor(deliver.process, resources.logger), { defaultForQueue: true });
		await owner.runtime.start({ timeout: config.processes.startupTimeoutMs });
		if (startupFailure) {
			throw startupFailure;
		}
		active = true;
		return stop;
	} catch (error) {
		await stop().catch((cleanupError: unknown) => resources.logger.error('cleanup.failed', { error: cleanupError }));
		// The library aggregate keeps cleanup failures in errors and the startup error in cause.
		let primary = error;
		while (primary instanceof AggregateError && primary.cause !== undefined) {
			primary = primary.cause;
		}
		throw startupFailure ?? primary;
	}
}
