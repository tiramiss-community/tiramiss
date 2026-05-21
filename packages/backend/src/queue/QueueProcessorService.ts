/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { WorkerHooks } from '@mokurokujs/core';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import type Logger from '@/logger.js';
import { wrapProcessor } from '@/queue/jobs/compat.js';
import {
	deleteAccountJob,
	deleteDriveFilesJob,
	exportAntennasJob,
	exportBlockingJob,
	exportClipsJob,
	exportCustomEmojisJob,
	exportFavoritesJob,
	exportFollowingJob,
	exportMutingJob,
	exportNotesJob,
	exportUserListsJob,
	importAntennasJob,
	importBlockingJob,
	importBlockingToDbJob,
	importCustomEmojisJob,
	importFollowingJob,
	importFollowingToDbJob,
	importMutingJob,
	importUserListsJob,
} from '@/queue/jobs/definitions/db.js';
import {
	deliverJob,
} from '@/queue/jobs/definitions/deliver.js';
import {
	inboxJob,
} from '@/queue/jobs/definitions/inbox.js';
import {
	endedPollNotificationJob,
	postScheduledNoteJob,
} from '@/queue/jobs/definitions/misc.js';
import {
	cleanRemoteFilesJob,
	deleteFileJob,
} from '@/queue/jobs/definitions/objectStorage.js';
import {
	blockJob,
	followJob,
	unblockJob,
	unfollowJob,
} from '@/queue/jobs/definitions/relationship.js';
import {
	aggregateRetentionJob,
	bakeBufferedReactionsJob,
	checkExpiredMutingsJob,
	checkModeratorsActivityJob,
	cleanChartsJob,
	cleanJob,
	cleanRemoteNotesJob,
	resyncChartsJob,
	tickChartsJob,
} from '@/queue/jobs/definitions/system.js';
import {
	systemWebhookDeliverJob,
	userWebhookDeliverJob,
} from '@/queue/jobs/definitions/webhook.js';
import { CheckModeratorsActivityProcessorService } from '@/queue/processors/CheckModeratorsActivityProcessorService.js';
import { QueueRuntimeService } from './QueueRuntimeService.js';
import { AggregateRetentionProcessorService } from './processors/AggregateRetentionProcessorService.js';
import { BakeBufferedReactionsProcessorService } from './processors/BakeBufferedReactionsProcessorService.js';
import { CheckExpiredMutingsProcessorService } from './processors/CheckExpiredMutingsProcessorService.js';
import { CleanChartsProcessorService } from './processors/CleanChartsProcessorService.js';
import { CleanProcessorService } from './processors/CleanProcessorService.js';
import { CleanRemoteFilesProcessorService } from './processors/CleanRemoteFilesProcessorService.js';
import { CleanRemoteNotesProcessorService } from './processors/CleanRemoteNotesProcessorService.js';
import { DeleteAccountProcessorService } from './processors/DeleteAccountProcessorService.js';
import { DeleteDriveFilesProcessorService } from './processors/DeleteDriveFilesProcessorService.js';
import { DeleteFileProcessorService } from './processors/DeleteFileProcessorService.js';
import { DeliverProcessorService } from './processors/DeliverProcessorService.js';
import { EndedPollNotificationProcessorService } from './processors/EndedPollNotificationProcessorService.js';
import { ExportAntennasProcessorService } from './processors/ExportAntennasProcessorService.js';
import { ExportBlockingProcessorService } from './processors/ExportBlockingProcessorService.js';
import { ExportClipsProcessorService } from './processors/ExportClipsProcessorService.js';
import { ExportCustomEmojisProcessorService } from './processors/ExportCustomEmojisProcessorService.js';
import { ExportFavoritesProcessorService } from './processors/ExportFavoritesProcessorService.js';
import { ExportFollowingProcessorService } from './processors/ExportFollowingProcessorService.js';
import { ExportMutingProcessorService } from './processors/ExportMutingProcessorService.js';
import { ExportNotesProcessorService } from './processors/ExportNotesProcessorService.js';
import { ExportUserListsProcessorService } from './processors/ExportUserListsProcessorService.js';
import { ImportAntennasProcessorService } from './processors/ImportAntennasProcessorService.js';
import { ImportBlockingProcessorService } from './processors/ImportBlockingProcessorService.js';
import { ImportCustomEmojisProcessorService } from './processors/ImportCustomEmojisProcessorService.js';
import { ImportFollowingProcessorService } from './processors/ImportFollowingProcessorService.js';
import { ImportMutingProcessorService } from './processors/ImportMutingProcessorService.js';
import { ImportUserListsProcessorService } from './processors/ImportUserListsProcessorService.js';
import { InboxProcessorService } from './processors/InboxProcessorService.js';
import { PostScheduledNoteProcessorService } from './processors/PostScheduledNoteProcessorService.js';
import { RelationshipProcessorService } from './processors/RelationshipProcessorService.js';
import { ResyncChartsProcessorService } from './processors/ResyncChartsProcessorService.js';
import { SystemWebhookDeliverProcessorService } from './processors/SystemWebhookDeliverProcessorService.js';
import { TickChartsProcessorService } from './processors/TickChartsProcessorService.js';
import { UserWebhookDeliverProcessorService } from './processors/UserWebhookDeliverProcessorService.js';
import { QueueLoggerService } from './QueueLoggerService.js';

function renderError(e?: Error) {
	// 何故かeがundefinedで来ることがある
	if (!e) return '?';

	if (e.name === 'UnrecoverableError' || e.name === 'AbortError') {
		return `${e.name}: ${e.message}`;
	}

	return {
		stack: e.stack,
		message: e.message,
		name: e.name,
	};
}

@Injectable()
export class QueueProcessorService implements OnApplicationShutdown {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		private queueRuntimeService: QueueRuntimeService,
		private queueLoggerService: QueueLoggerService,
		private userWebhookDeliverProcessorService: UserWebhookDeliverProcessorService,
		private systemWebhookDeliverProcessorService: SystemWebhookDeliverProcessorService,
		private endedPollNotificationProcessorService: EndedPollNotificationProcessorService,
		private postScheduledNoteProcessorService: PostScheduledNoteProcessorService,
		private deliverProcessorService: DeliverProcessorService,
		private inboxProcessorService: InboxProcessorService,
		private deleteDriveFilesProcessorService: DeleteDriveFilesProcessorService,
		private exportCustomEmojisProcessorService: ExportCustomEmojisProcessorService,
		private exportNotesProcessorService: ExportNotesProcessorService,
		private exportClipsProcessorService: ExportClipsProcessorService,
		private exportFavoritesProcessorService: ExportFavoritesProcessorService,
		private exportFollowingProcessorService: ExportFollowingProcessorService,
		private exportMutingProcessorService: ExportMutingProcessorService,
		private exportBlockingProcessorService: ExportBlockingProcessorService,
		private exportUserListsProcessorService: ExportUserListsProcessorService,
		private exportAntennasProcessorService: ExportAntennasProcessorService,
		private importFollowingProcessorService: ImportFollowingProcessorService,
		private importMutingProcessorService: ImportMutingProcessorService,
		private importBlockingProcessorService: ImportBlockingProcessorService,
		private importUserListsProcessorService: ImportUserListsProcessorService,
		private importCustomEmojisProcessorService: ImportCustomEmojisProcessorService,
		private importAntennasProcessorService: ImportAntennasProcessorService,
		private deleteAccountProcessorService: DeleteAccountProcessorService,
		private deleteFileProcessorService: DeleteFileProcessorService,
		private cleanRemoteFilesProcessorService: CleanRemoteFilesProcessorService,
		private relationshipProcessorService: RelationshipProcessorService,
		private tickChartsProcessorService: TickChartsProcessorService,
		private resyncChartsProcessorService: ResyncChartsProcessorService,
		private cleanChartsProcessorService: CleanChartsProcessorService,
		private aggregateRetentionProcessorService: AggregateRetentionProcessorService,
		private checkExpiredMutingsProcessorService: CheckExpiredMutingsProcessorService,
		private bakeBufferedReactionsProcessorService: BakeBufferedReactionsProcessorService,
		private checkModeratorsActivityProcessorService: CheckModeratorsActivityProcessorService,
		private cleanProcessorService: CleanProcessorService,
		private cleanRemoteNotesProcessorService: CleanRemoteNotesProcessorService,
	) {
		const jobRuntime = this.queueRuntimeService.jobRuntime;
		const schedulerRuntime = this.queueRuntimeService.schedulerRuntime;

		this.logger = this.queueLoggerService.logger;

		let Sentry: typeof import('@sentry/node') | undefined;
		if (this.config.sentryForBackend) {
			import('@sentry/node').then((mod) => {
				Sentry = mod;
			});
		}

		// 共通の WorkerHooks ファクトリ（コンストラクタ内限定）
		const makeHooks = (
			logger: Logger,
			label: string,
			level: 'debug' | 'info',
			overrides?: Partial<WorkerHooks>,
		): WorkerHooks => {
			const logStart = (msg: string) => (level === 'info' ? logger.info(msg) : logger.debug(msg));
			const logSuccess = (msg: string) => (level === 'info' ? logger.info(msg) : logger.debug(msg));

			const defaultHooks: WorkerHooks = {
				onStart: (ctx) => logStart(`active id=${ctx.jobId}`),
				onSuccess: (ctx) => logSuccess(`completed id=${ctx.jobId}`),
				onFailure: (ctx, err) => {
					const errName = err instanceof Error ? err.name : 'Error';
					const errMsg = err instanceof Error ? err.message : String(err);
					logger.error(`failed(${errName}: ${errMsg}) id=${ctx.jobId}`, {
						job: { name: ctx.jobName, id: ctx.jobId, attempt: ctx.attempt },
						e: renderError(err instanceof Error ? err : undefined),
					});
					if (Sentry != null) {
						Sentry.captureMessage(`Queue: ${label}: ${ctx.jobName}: ${errName}: ${errMsg}`, {
							level: 'error',
							extra: { job: { name: ctx.jobName, id: ctx.jobId }, err },
						});
					}
				},
			};

			return { ...defaultHooks, ...overrides };
		};

		//#region system
		{
			const logger = this.logger.createSubLogger('system');
			const createSystemHooks = () => makeHooks(logger, 'System', 'info', {
				onRetry: (ctx, err, remainingAttempts) => {
					const errName = err instanceof Error ? err.name : 'Error';
					const errMsg = err instanceof Error ? err.message : String(err);
					logger.warn(`retrying(${errName}: ${errMsg}) id=${ctx.jobId} remainingAttempts=${remainingAttempts}`, {
						job: { name: ctx.jobName, id: ctx.jobId, attempt: ctx.attempt },
						e: renderError(err instanceof Error ? err : undefined),
					});
				},
			});

			const scheduleOptions = {
				immediately: false,
				// 期限ではなくcountで設定したいが、ジョブごとではなくキュー全体でカウントされるため、高頻度で実行されるジョブによって低頻度で実行されるジョブのログが消えることになる
				removeOnCompleteAfterSec: 3600 * 24 * 7, // keep up to 7 days,
				removeOnFailAfterSec: 3600 * 24 * 7, // keep up to 7 days,
			};

			// 引数なしのProcessorServiceを使うジョブ
			jobRuntime.handle(tickChartsJob, () => this.tickChartsProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(tickChartsJob, { pattern: '55 * * * *', ...scheduleOptions });

			jobRuntime.handle(resyncChartsJob, () => this.resyncChartsProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(resyncChartsJob, { pattern: '0 0 * * *', ...scheduleOptions });

			jobRuntime.handle(cleanChartsJob, () => this.cleanChartsProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(cleanChartsJob, { pattern: '0 0 * * *', ...scheduleOptions });

			jobRuntime.handle(aggregateRetentionJob, () => this.aggregateRetentionProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(aggregateRetentionJob, { pattern: '0 0 * * *', ...scheduleOptions });

			jobRuntime.handle(cleanJob, () => this.cleanProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(cleanJob, { pattern: '0 0 * * *', ...scheduleOptions });

			jobRuntime.handle(checkExpiredMutingsJob, () => this.checkExpiredMutingsProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(checkExpiredMutingsJob, { pattern: '*/5 * * * *', ...scheduleOptions });

			jobRuntime.handle(bakeBufferedReactionsJob, () => this.bakeBufferedReactionsProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(bakeBufferedReactionsJob, { pattern: '0 0 * * *', ...scheduleOptions });

			// 毎時30分に起動
			jobRuntime.handle(checkModeratorsActivityJob, () => this.checkModeratorsActivityProcessorService.process(), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(checkModeratorsActivityJob, { pattern: '30 * * * *', ...scheduleOptions });

			// Bull.Jobを受け取るProcessorServiceを使うジョブ（毎日午前4時に起動 - 最も人の少ない時間帯）
			jobRuntime.handle(cleanRemoteNotesJob, wrapProcessor((job) => this.cleanRemoteNotesProcessorService.process(job)), { hooks: createSystemHooks() });
			schedulerRuntime.upsert(cleanRemoteNotesJob, { pattern: '0 4 * * *', ...scheduleOptions });
		}
		//#endregion

		//#region db
		{
			const logger = this.logger.createSubLogger('db');
			const hooks = makeHooks(logger, 'DB', 'debug');

			// DB キューのジョブハンドラーを登録
			jobRuntime.handle(deleteDriveFilesJob, wrapProcessor((job) => this.deleteDriveFilesProcessorService.process(job)), { hooks });
			jobRuntime.handle(deleteAccountJob, wrapProcessor((job) => this.deleteAccountProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportCustomEmojisJob, wrapProcessor((job) => this.exportCustomEmojisProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportNotesJob, wrapProcessor((job) => this.exportNotesProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportClipsJob, wrapProcessor((job) => this.exportClipsProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportFavoritesJob, wrapProcessor((job) => this.exportFavoritesProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportFollowingJob, wrapProcessor((job) => this.exportFollowingProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportMutingJob, wrapProcessor((job) => this.exportMutingProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportBlockingJob, wrapProcessor((job) => this.exportBlockingProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportUserListsJob, wrapProcessor((job) => this.exportUserListsProcessorService.process(job)), { hooks });
			jobRuntime.handle(exportAntennasJob, wrapProcessor((job) => this.exportAntennasProcessorService.process(job)), { hooks });
			jobRuntime.handle(importFollowingJob, wrapProcessor((job) => this.importFollowingProcessorService.process(job)), { hooks });
			jobRuntime.handle(importFollowingToDbJob, wrapProcessor((job) => this.importFollowingProcessorService.processDb(job)), { hooks });
			jobRuntime.handle(importMutingJob, wrapProcessor((job) => this.importMutingProcessorService.process(job)), { hooks });
			jobRuntime.handle(importBlockingJob, wrapProcessor((job) => this.importBlockingProcessorService.process(job)), { hooks });
			jobRuntime.handle(importBlockingToDbJob, wrapProcessor((job) => this.importBlockingProcessorService.processDb(job)), { hooks });
			jobRuntime.handle(importUserListsJob, wrapProcessor((job) => this.importUserListsProcessorService.process(job)), { hooks });
			jobRuntime.handle(importCustomEmojisJob, wrapProcessor((job) => this.importCustomEmojisProcessorService.process(job)), { hooks });
			jobRuntime.handle(importAntennasJob, wrapProcessor((job) => this.importAntennasProcessorService.process(job)), { hooks });
		}
		//#endregion

		//#region deliver
		{
			const logger = this.logger.createSubLogger('deliver');
			const hooks = makeHooks(logger, 'Deliver', 'debug');
			jobRuntime.handle(deliverJob, wrapProcessor((job) => this.deliverProcessorService.process(job)), { hooks });
		}
		//#endregion

		//#region inbox
		{
			const logger = this.logger.createSubLogger('inbox');
			const hooks = makeHooks(logger, 'Inbox', 'debug', {
				onFailure: (ctx, err) => {
					const errName = err instanceof Error ? err.name : 'Error';
					const errMsg = err instanceof Error ? err.message : String(err);
					logger.error(`failed(${errName}: ${errMsg}) id=${ctx.jobId}`, {
						job: { name: ctx.jobName, id: ctx.jobId, attempt: ctx.attempt },
						e: renderError(err instanceof Error ? err : undefined),
					});
					if (Sentry != null) {
						// inbox は jobName を含めない
						Sentry.captureMessage(`Queue: Inbox: ${errName}: ${errMsg}`, {
							level: 'error',
							extra: { job: { name: ctx.jobName, id: ctx.jobId }, err },
						});
					}
				},
			});
			jobRuntime.handle(inboxJob, wrapProcessor((job) => this.inboxProcessorService.process(job)), { hooks });
		}
		//#endregion

		//#region user-webhook deliver
		{
			const logger = this.logger.createSubLogger('user-webhook');
			const hooks = makeHooks(logger, 'UserWebhookDeliver', 'debug');
			jobRuntime.handle(userWebhookDeliverJob, wrapProcessor((job) => this.userWebhookDeliverProcessorService.process(job)), { hooks });
		}
		//#endregion

		//#region system-webhook deliver
		{
			const logger = this.logger.createSubLogger('system-webhook');
			const hooks = makeHooks(logger, 'SystemWebhookDeliver', 'debug');
			jobRuntime.handle(systemWebhookDeliverJob, wrapProcessor((job) => this.systemWebhookDeliverProcessorService.process(job)), { hooks });
		}
		//#endregion

		//#region relationship
		{
			const logger = this.logger.createSubLogger('relationship');
			const hooks = makeHooks(logger, 'Relationship', 'debug');
			jobRuntime.handle(followJob, wrapProcessor((job) => this.relationshipProcessorService.processFollow(job)), { hooks });
			jobRuntime.handle(unfollowJob, wrapProcessor((job) => this.relationshipProcessorService.processUnfollow(job)), { hooks });
			jobRuntime.handle(blockJob, wrapProcessor((job) => this.relationshipProcessorService.processBlock(job)), { hooks });
			jobRuntime.handle(unblockJob, wrapProcessor((job) => this.relationshipProcessorService.processUnblock(job)), { hooks });
		}
		//#endregion

		//#region object storage
		{
			const logger = this.logger.createSubLogger('objectStorage');
			const hooks = makeHooks(logger, 'ObjectStorage', 'debug');
			jobRuntime.handle(deleteFileJob, wrapProcessor((job) => this.deleteFileProcessorService.process(job)), { hooks });
			jobRuntime.handle(cleanRemoteFilesJob, wrapProcessor((job) => this.cleanRemoteFilesProcessorService.process(job)), { hooks });
		}
		//#endregion

		//#region ended poll notification
		{
			jobRuntime.handle(endedPollNotificationJob, wrapProcessor((job) => this.endedPollNotificationProcessorService.process(job)));
		}
		//#endregion

		//#region post scheduled note
		{
			jobRuntime.handle(postScheduledNoteJob, wrapProcessor((job) => this.postScheduledNoteProcessorService.process(job)));
		}
		//#endregion
	}

	@bindThis
	public async start(): Promise<void> {
		await this.queueRuntimeService.jobRuntime.start();
	}

	@bindThis
	public async stop(): Promise<void> {
		await this.queueRuntimeService.jobRuntime.stop({ timeout: 10_000 });
	}

	@bindThis
	public async onApplicationShutdown(signal?: string | undefined): Promise<void> {
		await this.stop();
	}
}
