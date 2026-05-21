/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { BullMQQueueManager, createBullmqBackend, createBullmqScheduler } from '@mokurokujs/bullmq-adapter';
import { JobRuntime, SchedulerRuntime } from '@mokurokujs/core';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { LoggerService } from '@/core/LoggerService.js';
import { QUEUE_TYPES } from '@/queue/const.js';
import type Logger from '@/logger.js';
import type { JobLogger } from '@mokurokujs/core';

@Injectable()
export class QueueRuntimeService {
	public readonly queueManager: BullMQQueueManager;
	public readonly jobRuntime: JobRuntime;
	public readonly schedulerRuntime: SchedulerRuntime;
	private readonly logger: Logger;
	private readonly jobLogger: JobLogger;

	constructor(
		@Inject(DI.config) config: Config,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('queue-runtime', 'orange');

		const redisForJobQueueByQueueKeys = Object.keys(config.redisForJobQueueByQueue ?? {});
		const unknownQueueNames = redisForJobQueueByQueueKeys.filter((queueName) => !QUEUE_TYPES.includes(queueName as any));
		if (unknownQueueNames.length > 0) {
			this.logger.warn('config.redisForJobQueueByQueue contains unknown queue names; they will be ignored', {
				unknownQueueNames,
				knownQueueNames: QUEUE_TYPES,
			});
		}

		this.jobLogger = {
			debug: (message, meta) => this.logger.debug(message, meta ?? ''),
			info: (message, meta) => this.logger.info(message, meta ?? ''),
			warn: (message, meta) => this.logger.warn(message, meta ?? ''),
			error: (message, meta) => this.logger.error(message, meta ?? ''),
		};

		this.queueManager = new BullMQQueueManager({
			...config.redisForJobQueue,
			keyPrefix: undefined,
		});

		const backend = createBullmqBackend({
			queueManager: this.queueManager,
			logger: this.jobLogger,
			hooks: {
				onEnqueue: ({ jobName, payload, queue }) => {
					this.jobLogger.debug('job.enqueue', { jobName, payload, queue });
				},
				onStart: (ctx) => {
					this.jobLogger.debug('job.start', { jobName: ctx.jobName, jobId: ctx.jobId });
				},
				onSuccess: (ctx) => {
					this.jobLogger.debug('job.success', { jobName: ctx.jobName, jobId: ctx.jobId });
				},
				onRetry: (ctx, error, remainingAttempts) => {
					this.jobLogger.warn('job.retry', {
						jobName: ctx.jobName,
						jobId: ctx.jobId,
						error: String(error),
						remainingAttempts,
					});
				},
				onFailure: (ctx, error) => {
					this.jobLogger.error('job.failure', {
						jobName: ctx.jobName,
						jobId: ctx.jobId,
						error: String(error),
					});
				},
			},
		});

		const scheduler = createBullmqScheduler({
			queueManager: this.queueManager,
			hooks: {
				onUpsert: ({ jobName, pattern, immediately }) => {
					this.jobLogger.debug('scheduler.upsert', { jobName, pattern, immediately });
				},
				onRemove: ({ jobName }) => {
					this.jobLogger.debug('scheduler.remove', { jobName });
				},
			},
		});

		this.jobRuntime = new JobRuntime(backend);
		this.schedulerRuntime = new SchedulerRuntime(scheduler);
	}

	public async dispose(): Promise<void> {
		await this.jobRuntime.stop({ timeout: 10_000 }).catch(() => {});
		await this.queueManager.closeAll({ timeout: 10_000 }).catch(() => {});
	}
}
