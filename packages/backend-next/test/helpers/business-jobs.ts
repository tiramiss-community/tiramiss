/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createBusinessJobDefinitions, createBusinessJobProducers } from '../../src/platform/job-queue/business-jobs.js';
import { createBusinessJobRuntime } from '../../src/platform/job-queue/runtime.js';
import { createDeliverProcessor } from '../../src/platform/job-queue/deliver.js';
import { createPollEndedProcessor } from '../../src/platform/job-queue/ended-poll-notification.js';
import { createUserWebhookJobProcessor } from '../../src/platform/job-queue/user-webhook.js';
import { DiagnosticError } from '../../src/platform/diagnostic-error.js';
import type { BusinessJobConfig } from '../../src/platform/job-queue/business-jobs.js';
import type { Logger } from '../../src/platform/logger.js';

type Connection = BusinessJobConfig & { logger: Logger };

// Keep producer and worker ownership separate, including when a test restarts a worker.
export function openBusinessJobProducers(options: Connection & { onLost(): void }) {
	const definitions = createBusinessJobDefinitions(options);
	const owner = createBusinessJobRuntime({ ...options, onError(event) {
		if (event.reason === 'connection-ended') {
			options.onLost();
		}
	} });
	return {
		...createBusinessJobProducers(owner, definitions, options),
		ready: () => owner.runtime.ready(definitions.queues, { timeout: options.connectTimeoutMs }),
		close: () => owner.stop(),
	};
}

function workerOwner(options: Connection & { reportFailure(error: Error): void }) {
	return createBusinessJobRuntime({ ...options, onError(event) {
		const code = event.reason === 'connection-ended' ? 'JOB_QUEUE_REDIS_ENDED'
			: event.reason === 'run-fulfilled' ? 'JOB_WORKER_STOPPED'
			: event.reason === 'run-rejected' ? 'JOB_WORKER_FAILED' : undefined;
		if (code) {
			options.reportFailure(new DiagnosticError(code, { queue: event.queue }));
		}
	} });
}

export async function openPollEndedWorker(options: Connection & {
	handle: Parameters<typeof createPollEndedProcessor>[0]; reportFailure(error: Error): void;
}) {
	const definitions = createBusinessJobDefinitions(options);
	const owner = workerOwner(options);
	owner.runtime.handle(definitions.pollEnded, createPollEndedProcessor(options.handle, options.logger), { defaultForQueue: true });
	try {
		await owner.runtime.start({ timeout: options.connectTimeoutMs });
	} catch (error) {
		await owner.stop();
		throw error;
	}
	return () => owner.stop();
}

export async function openDeliverWorker(options: Connection & {
	config: Pick<BusinessJobConfig, 'deliverJobConcurrency' | 'deliverJobPerSec'>;
	process: Parameters<typeof createDeliverProcessor>[0]; reportFailure(error: Error): void;
}) {
	const definitions = createBusinessJobDefinitions({ ...options, ...options.config });
	const owner = workerOwner(options);
	owner.runtime.handle(definitions.deliver, createDeliverProcessor(options.process, options.logger), { defaultForQueue: true });
	try {
		await owner.runtime.start({ timeout: options.connectTimeoutMs });
	} catch (error) {
		await owner.stop();
		throw error;
	}
	return () => owner.stop();
}

export async function openUserWebhookWorker(options: Connection & {
	process: Parameters<typeof createUserWebhookJobProcessor>[0]; reportFailure(error: Error): void;
}) {
	const definitions = createBusinessJobDefinitions(options);
	const owner = workerOwner(options);
	owner.runtime.handle(definitions.userWebhook, createUserWebhookJobProcessor(options.process, options.logger), { defaultForQueue: true });
	try {
		await owner.runtime.start({ timeout: options.connectTimeoutMs });
	} catch (error) {
		await owner.stop();
		throw error;
	}
	return () => owner.stop();
}
