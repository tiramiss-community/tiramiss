/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { JobHandlerContext } from '@mokurokujs/core';
import type { Job, Worker } from 'bullmq';
import type { Logger } from '../logger.js';

export function safeJobDestination(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return '[INVALID_URL]';
		}
		return url.origin;
	} catch {
		return '[INVALID_URL]';
	}
}

export function writeWorkerLog(write: () => void): void {
	try {
		write();
	} catch {
		// Diagnostics must not change the processor's outcome or manufacture a Worker error.
	}
}

export function failedJobFields(context: JobHandlerContext) {
	const job = context.rawJob as Pick<Job, 'opts'> | undefined;
	return {
		jobId: context.jobId,
		attemptsMade: context.attempt - 1,
		maxAttempts: job?.opts.attempts ?? 0,
		ageMs: Date.now() - context.timestamp.getTime(),
	};
}

function deliveryFields(queue: string, job: Job) {
	return {
		queue,
		jobId: job.id,
		// Preserve upstream's +1 for active AND completed, even when BullMQ already incremented it.
		attemptsMade: job.attemptsMade + 1,
		maxAttempts: job.opts.attempts ?? 0,
		ageMs: Date.now() - job.timestamp,
		to: safeJobDestination((job.data as { to?: unknown } | null)?.to),
	};
}

export function observeDeliveryWorker(queue: string, worker: Worker, logger: Logger): void {
	// Upstream deliberately has no event listeners for endedPollNotification.
	if (queue !== 'deliver' && queue !== 'userWebhookDeliver') {
		return;
	}
	worker
		.on('active', job => writeWorkerLog(() => logger.debug?.('job.active', deliveryFields(queue, job))))
		.on('completed', (job, result: unknown) => writeWorkerLog(() => logger.debug?.('job.completed', { ...deliveryFields(queue, job), result })))
		.on('error', error => writeWorkerLog(() => logger.error('job.worker-error', { queue, error })))
		.on('stalled', jobId => writeWorkerLog(() => logger.warn?.('job.stalled', { queue, jobId })));
}
