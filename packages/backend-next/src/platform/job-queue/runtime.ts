/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { JobRuntime } from '@mokurokujs/core';
import { BullMQQueueManager, createBullmqBackend } from '@mokurokujs/bullmq-adapter';
import { baseQueueOptions } from './connection.js';
import type { BullmqManagerError } from '@mokurokujs/bullmq-adapter';
import type { RedisConfig } from '../../config/types.js';
import type { BusinessQueueName } from './business-jobs.js';

class ObservedQueueManager extends BullMQQueueManager {
	private readonly observedWorkers = new Map<string, Awaited<ReturnType<BullMQQueueManager['createWorker']>>>();

	override async createWorker(...args: Parameters<BullMQQueueManager['createWorker']>): ReturnType<BullMQQueueManager['createWorker']> {
		const worker = await super.createWorker(...args);
		this.observedWorkers.set(args[0].name, worker);
		return worker;
	}

	async closedWorkerQueues(): Promise<ReadonlySet<BusinessQueueName>> {
		const closed = new Set<BusinessQueueName>();
		await Promise.all([...this.observedWorkers].map(async ([name, worker]) => {
			if (worker.closing === undefined) {
				return;
			}
			try {
				await worker.closing;
				if (name === 'deliver' || name === 'endedPollNotification' || name === 'userWebhookDeliver') {
					closed.add(name);
				}
			} catch {
				// A diagnostic alone cannot establish whether close fulfilled.
			}
		}));
		return closed;
	}
}

export interface OwnedBusinessJobRuntime {
	readonly runtime: JobRuntime;
	assertOpen(): void;
	stop(): Promise<void>;
	closedWorkerQueues(): Promise<ReadonlySet<BusinessQueueName>>;
}

export function createBusinessJobRuntime(options: { redis: RedisConfig; connectTimeoutMs: number; onError(event: BullmqManagerError): void }): OwnedBusinessJobRuntime {
	const manager = new ObservedQueueManager(baseQueueOptions(options.redis, 'deliver', options.connectTimeoutMs).connection, { onError: options.onError });
	const runtime = new JobRuntime(createBullmqBackend({ queueManager: manager }));
	let terminal = false;
	let stopping: Promise<void> | undefined;
	return {
		runtime,
		assertOpen() {
			if (terminal) {
				throw new Error('Business job runtime is closed');
			}
		},
		stop() {
			terminal = true;
			return stopping ??= runtime.stop();
		},
		closedWorkerQueues: () => manager.closedWorkerQueues(),
	};
}
