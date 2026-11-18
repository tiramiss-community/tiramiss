/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { JobRuntime } from '@mokurokujs/core';
import { BullMQQueueManager, createBullmqBackend } from '@mokurokujs/bullmq-adapter';
import { observeDeliveryWorker } from './worker-logging.js';
import type { Logger } from '../logger.js';
import { baseQueueOptions } from './connection.js';
import type { BullmqManagerError } from '@mokurokujs/bullmq-adapter';
import type { RedisConfig } from '../../config/types.js';
import type { BusinessQueueName } from './business-jobs.js';
import type { QueueDefinition } from '@mokurokujs/core';
import type { Queue } from 'bullmq';

class ObservedQueueManager extends BullMQQueueManager {
	workerLogger?: Logger;
	private readonly observedWorkers = new Map<string, Awaited<ReturnType<BullMQQueueManager['createWorker']>>>();

	override async createWorker(...args: Parameters<BullMQQueueManager['createWorker']>): ReturnType<BullMQQueueManager['createWorker']> {
		const worker = await super.createWorker(...args);
		this.observedWorkers.set(args[0].name, worker);
		if (this.workerLogger) {
			observeDeliveryWorker(args[0].name, worker, this.workerLogger);
		}
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
				if (name === 'deliver' || name === 'endedPollNotification' || name === 'userWebhookDeliver' || name === 'system') {
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
	queue(definition: QueueDefinition): Pick<Queue, 'getJob' | 'remove'>;
	stop(): Promise<void>;
	closedWorkerQueues(): Promise<ReadonlySet<BusinessQueueName>>;
}

export function createBusinessJobRuntime(options: { redis: RedisConfig; connectTimeoutMs: number; logger?: Logger; onError(event: BullmqManagerError): void }): OwnedBusinessJobRuntime {
	const manager = new ObservedQueueManager(baseQueueOptions(options.redis, 'deliver', options.connectTimeoutMs).connection, { onError: options.onError });
	manager.workerLogger = options.logger;
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
		queue(definition) {
			if (terminal) {
				throw new Error('Business job runtime is closed');
			}
			return manager.getOrCreateQueue(definition);
		},
		stop() {
			terminal = true;
			return stopping ??= runtime.stop();
		},
		closedWorkerQueues: () => manager.closedWorkerQueues(),
	};
}
