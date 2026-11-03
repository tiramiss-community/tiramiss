/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createDeliverJobHandler } from '../composition/deliver-job.js';
import { createPollEndedHandler } from '../composition/poll-ended-job.js';
import { startDeliverWorker } from '../platform/job-queue/deliver.js';
import { startPollEndedWorker } from '../platform/job-queue/ended-poll-notification.js';
import { startManagedProcess } from './lifecycle.js';
import type { RuntimeConfig } from '../config/types.js';

// 1 つの停止に失敗しても、他の Worker の停止を待たずに抜けない。
async function stopAll(stops: readonly (() => Promise<void>)[]): Promise<void> {
	const results = await Promise.allSettled(stops.map(stop => stop()));
	const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
	if (errors.length > 0) {
		throw new AggregateError(errors, 'Worker stop failed');
	}
}

export function startWorker(config: RuntimeConfig) {
	// 実ジョブのある queue だけを取得する。汎用の dispatcher や handler のない Worker は作らない。
	return startManagedProcess('worker', config, async (resources, reportFailure) => {
		const connection = { redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs, logger: resources.logger };
		const stops: (() => Promise<void>)[] = [];

		try {
			stops.push(await startPollEndedWorker({ ...connection, handle: createPollEndedHandler(resources, config), reportFailure }));

			const deliver = createDeliverJobHandler(resources, config);
			const stopDeliver = await startDeliverWorker({
				...connection,
				config: { deliverJobConcurrency: config.outboundHttp.deliverJobConcurrency, deliverJobPerSec: config.deliverJob.deliverJobPerSec },
				process: deliver.process,
				reportFailure,
			});
			stops.push(async () => {
				await stopDeliver();
				await deliver.idle();
			});
		} catch (error) {
			await stopAll(stops).catch((cleanupError: unknown) => {
				resources.logger.error('cleanup.failed', { error: cleanupError });
			});
			throw error;
		}

		return () => stopAll(stops);
	});
}
