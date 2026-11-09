/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createQueueWorkers } from '../composition/queue-workers.js';
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
		const workers = createQueueWorkers(resources, config, reportFailure);
		const stops: (() => Promise<void>)[] = [];

		try {
			for (const worker of workers) {
				stops.push(await worker.start());
			}
		} catch (error) {
			await stopAll(stops).catch((cleanupError: unknown) => {
				resources.logger.error('cleanup.failed', { error: cleanupError });
			});
			throw error;
		}

		return () => stopAll(stops);
	});
}
