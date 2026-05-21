/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { MetricsTime, type JobType } from 'bullmq';
import type { IActivity } from '@/core/activitypub/type.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiWebhook, WebhookEventTypes } from '@/models/Webhook.js';
import type { MiSystemWebhook, SystemWebhookEventType } from '@/models/SystemWebhook.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { Antenna } from '@/server/api/endpoints/i/import-antennas.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { type SystemWebhookPayload } from '@/core/SystemWebhookService.js';
import type { Packed } from '@/misc/json-schema.js';
import { QUEUE_TYPES, type QueueType } from '@/queue/const.js';
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
import { deliverJob } from '@/queue/jobs/definitions/deliver.js';
import { inboxJob } from '@/queue/jobs/definitions/inbox.js';
import { cleanRemoteFilesJob, deleteFileJob } from '@/queue/jobs/definitions/objectStorage.js';
import { blockJob, followJob, unblockJob, unfollowJob } from '@/queue/jobs/definitions/relationship.js';
import { systemWebhookDeliverJob, userWebhookDeliverJob } from '@/queue/jobs/definitions/webhook.js';
import { QueueRuntimeService } from '@/queue/QueueRuntimeService.js';
import { endedPollNotificationJob } from '@/queue/jobs/definitions/misc.js';
import { queueDefinitionFromType } from '@/queue/jobs/queueDefinitions.js';
import { type UserWebhookPayload } from './UserWebhookService.js';
import type * as Bull from 'bullmq';
import type httpSignature from '@peertube/http-signature';
import type {
	DeliverJobData,
	SystemWebhookDeliverJobData,
	ThinUser,
	UserWebhookDeliverJobData,
} from '../queue/types.js';

function parseRedisInfo(infoText: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of infoText.split('\n')) {
		if (line.length === 0 || line.startsWith('#')) continue;
		const [key, value] = line.trim().split(':');
		result[key] = value;
	}
	return result;
}

@Injectable()
export class QueueService {
	constructor(
		private queueRuntimeService: QueueRuntimeService,
	) {
	}

	private get jobRuntime() {
		return this.queueRuntimeService.jobRuntime;
	}

	private get queueManager() {
		return this.queueRuntimeService.queueManager;
	}

	@bindThis
	public deliver(user: ThinUser, content: IActivity | null, to: string | null, isSharedInbox: boolean) {
		if (content == null) return null;
		if (to == null) return null;

		const contentBody = JSON.stringify(content);
		const digest = ApRequestCreator.createDigest(contentBody);

		const data: DeliverJobData = {
			user: {
				id: user.id,
			},
			content: contentBody,
			digest,
			to,
			isSharedInbox,
		};

		// NOTE: mokuroku uses BullMQ job.name to resolve handlers; do not override jobName here.
		return this.jobRuntime.enqueue(deliverJob, data);
	}

	/**
	 * ApDeliverManager-DeliverManager.execute()からinboxesを突っ込んでaddBulkしたい
	 * @param user `{ id: string; }` この関数ではThinUserに変換しないので前もって変換してください
	 * @param content IActivity | null
	 * @param inboxes `Map<string, boolean>` / key: to (inbox url), value: isSharedInbox (whether it is sharedInbox)
	 * @returns void
	 */
	@bindThis
	public async deliverMany(user: ThinUser, content: IActivity | null, inboxes: Map<string, boolean>) {
		if (content == null) return null;
		const contentBody = JSON.stringify(content);
		const digest = ApRequestCreator.createDigest(contentBody);

		const items = Array.from(inboxes.entries(), ([to, isSharedInbox]) => ({
			payload: {
				user,
				content: contentBody,
				digest,
				to,
				isSharedInbox,
			} as DeliverJobData,
		}));

		await this.jobRuntime.enqueueBulk(deliverJob, items);

		return;
	}

	@bindThis
	public inbox(activity: IActivity, signature: httpSignature.IParsedSignature) {
		const data = {
			activity: activity,
			signature,
		};

		const label = (activity.id ?? '').replace('https://', '').replace('/activity', '');

		// NOTE: mokuroku uses BullMQ job.name to resolve handlers; do not override jobName here.
		return this.jobRuntime.enqueue(inboxJob, data);
	}

	@bindThis
	public createDeleteDriveFilesJob(user: ThinUser) {
		return this.jobRuntime.enqueue(deleteDriveFilesJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportCustomEmojisJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportCustomEmojisJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportNotesJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportNotesJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportClipsJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportClipsJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportFavoritesJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportFavoritesJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportFollowingJob(user: ThinUser, excludeMuting = false, excludeInactive = false) {
		return this.jobRuntime.enqueue(exportFollowingJob, {
			user: { id: user.id },
			excludeMuting,
			excludeInactive,
		});
	}

	@bindThis
	public createExportMuteJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportMutingJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportBlockingJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportBlockingJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportUserListsJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportUserListsJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createExportAntennasJob(user: ThinUser) {
		return this.jobRuntime.enqueue(exportAntennasJob, {
			user: { id: user.id },
		});
	}

	@bindThis
	public createImportFollowingJob(user: ThinUser, fileId: MiDriveFile['id'], withReplies?: boolean) {
		return this.jobRuntime.enqueue(importFollowingJob, {
			user: { id: user.id },
			fileId: fileId,
			withReplies,
		});
	}

	@bindThis
	public createImportFollowingToDbJob(user: ThinUser, targets: string[], withReplies?: boolean) {
		const items = targets.map(target => ({
			payload: { user, target, withReplies },
		}));
		return this.jobRuntime.enqueueBulk(importFollowingToDbJob, items);
	}

	@bindThis
	public createImportMutingJob(user: ThinUser, fileId: MiDriveFile['id']) {
		return this.jobRuntime.enqueue(importMutingJob, {
			user: { id: user.id },
			fileId: fileId,
		});
	}

	@bindThis
	public createImportBlockingJob(user: ThinUser, fileId: MiDriveFile['id']) {
		return this.jobRuntime.enqueue(importBlockingJob, {
			user: { id: user.id },
			fileId: fileId,
		});
	}

	@bindThis
	public createImportBlockingToDbJob(user: ThinUser, targets: string[]) {
		const items = targets.map(target => ({
			payload: { user, target },
		}));
		return this.jobRuntime.enqueueBulk(importBlockingToDbJob, items);
	}

	@bindThis
	public createImportUserListsJob(user: ThinUser, fileId: MiDriveFile['id']) {
		return this.jobRuntime.enqueue(importUserListsJob, {
			user: { id: user.id },
			fileId: fileId,
		});
	}

	@bindThis
	public createImportCustomEmojisJob(user: ThinUser, fileId: MiDriveFile['id']) {
		return this.jobRuntime.enqueue(importCustomEmojisJob, {
			user: { id: user.id },
			fileId: fileId,
		});
	}

	@bindThis
	public createImportAntennasJob(user: ThinUser, antenna: Antenna) {
		return this.jobRuntime.enqueue(importAntennasJob, {
			user: { id: user.id },
			antenna,
		});
	}

	@bindThis
	public createDeleteAccountJob(user: ThinUser, opts: { soft?: boolean; } = {}) {
		return this.jobRuntime.enqueue(deleteAccountJob, {
			user: { id: user.id },
			soft: opts.soft,
		});
	}

	@bindThis
	public createFollowJob(followings: { from: ThinUser, to: ThinUser, requestId?: string, silent?: boolean, withReplies?: boolean }[]) {
		const items = followings.map(rel => ({
			payload: {
				from: { id: rel.from.id },
				to: { id: rel.to.id },
				silent: rel.silent,
				requestId: rel.requestId,
				withReplies: rel.withReplies,
			},
		}));
		return this.jobRuntime.enqueueBulk(followJob, items);
	}

	@bindThis
	public createUnfollowJob(followings: { from: ThinUser, to: ThinUser, requestId?: string }[]) {
		const items = followings.map(rel => ({
			payload: {
				from: { id: rel.from.id },
				to: { id: rel.to.id },
				requestId: rel.requestId,
			},
		}));
		return this.jobRuntime.enqueueBulk(unfollowJob, items);
	}

	@bindThis
	public createDelayedUnfollowJob(followings: { from: ThinUser, to: ThinUser, requestId?: string }[], delay: number) {
		const items = followings.map(rel => ({
			payload: {
				from: { id: rel.from.id },
				to: { id: rel.to.id },
				requestId: rel.requestId,
			},
			options: { delay },
		}));
		return this.jobRuntime.enqueueBulk(unfollowJob, items);
	}

	@bindThis
	public createBlockJob(blockings: { from: ThinUser, to: ThinUser, silent?: boolean }[]) {
		const items = blockings.map(rel => ({
			payload: {
				from: { id: rel.from.id },
				to: { id: rel.to.id },
				silent: rel.silent,
			},
		}));
		return this.jobRuntime.enqueueBulk(blockJob, items);
	}

	@bindThis
	public createUnblockJob(blockings: { from: ThinUser, to: ThinUser, silent?: boolean }[]) {
		const items = blockings.map(rel => ({
			payload: {
				from: { id: rel.from.id },
				to: { id: rel.to.id },
				silent: rel.silent,
			},
		}));
		return this.jobRuntime.enqueueBulk(unblockJob, items);
	}

	@bindThis
	public createDeleteObjectStorageFileJob(key: string) {
		return this.jobRuntime.enqueue(deleteFileJob, {
			key: key,
		});
	}

	@bindThis
	public createCleanRemoteFilesJob() {
		return this.jobRuntime.enqueue(cleanRemoteFilesJob, {});
	}

	/**
	 * @see UserWebhookDeliverJobData
	 * @see UserWebhookDeliverProcessorService
	 */
	@bindThis
	public userWebhookDeliver<T extends WebhookEventTypes>(
		webhook: MiWebhook,
		type: T,
		content: UserWebhookPayload<T>,
		opts?: { attempts?: number },
	) {
		const data: UserWebhookDeliverJobData = {
			type,
			content,
			webhookId: webhook.id,
			userId: webhook.userId,
			to: webhook.url,
			secret: webhook.secret,
			createdAt: Date.now(),
			eventId: randomUUID(),
		};

		return this.jobRuntime.enqueue(userWebhookDeliverJob, data, {
			attempts: opts?.attempts,
		});
	}

	/**
	 * @see SystemWebhookDeliverJobData
	 * @see SystemWebhookDeliverProcessorService
	 */
	@bindThis
	public systemWebhookDeliver<T extends SystemWebhookEventType>(
		webhook: MiSystemWebhook,
		type: T,
		content: SystemWebhookPayload<T>,
		opts?: { attempts?: number },
	) {
		const data: SystemWebhookDeliverJobData = {
			type,
			content,
			webhookId: webhook.id,
			to: webhook.url,
			secret: webhook.secret,
			createdAt: Date.now(),
			eventId: randomUUID(),
		};

		return this.jobRuntime.enqueue(systemWebhookDeliverJob, data, {
			attempts: opts?.attempts,
		});
	}

	@bindThis
	public async postScheduledNote(noteId: string, delay: number) {
		return this.jobRuntime.enqueue(endedPollNotificationJob, { noteId }, { delay });
	}

	public async endedPollNotification(noteId: string, delay: number) {
		return this.jobRuntime.enqueue(endedPollNotificationJob, { noteId }, { delay });
	}

	@bindThis
	public getQueue(type: QueueType): Bull.Queue {
		if (!QUEUE_TYPES.includes(type)) {
			throw new Error(`Unrecognized queue type: ${type}`);
		}

		return this.queueManager.getOrCreateQueue(queueDefinitionFromType(type));
	}

	@bindThis
	public async queueClear(queueType: QueueType, state: '*' | 'completed' | 'wait' | 'active' | 'paused' | 'prioritized' | 'delayed' | 'failed') {
		const queue = this.getQueue(queueType);

		if (state === '*') {
			await Promise.all([
				queue.clean(0, 0, 'completed'),
				queue.clean(0, 0, 'wait'),
				queue.clean(0, 0, 'active'),
				queue.clean(0, 0, 'paused'),
				queue.clean(0, 0, 'prioritized'),
				queue.clean(0, 0, 'delayed'),
				queue.clean(0, 0, 'failed'),
			]);
		} else {
			await queue.clean(0, 0, state);
		}
	}

	@bindThis
	public async queuePromoteJobs(queueType: QueueType) {
		const queue = this.getQueue(queueType);
		await queue.promoteJobs();
	}

	@bindThis
	public async queueRetryJob(queueType: QueueType, jobId: string) {
		const queue = this.getQueue(queueType);
		const job = await queue.getJob(jobId);
		if (job != null) {
			if (job.finishedOn != null) {
				await job.retry();
			} else {
				await job.promote();
			}
		}
	}

	@bindThis
	public async queueRemoveJob(queueType: QueueType, jobId: string) {
		const queue = this.getQueue(queueType);
		const job = await queue.getJob(jobId);
		if (job != null) {
			await job.remove();
		}
	}

	@bindThis
	private packJobData(job: Bull.Job): Packed<'QueueJob'> {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		const stacktrace = job.stacktrace ? job.stacktrace.filter(Boolean) : [];
		stacktrace.reverse();

		return {
			id: job.id!,
			name: job.name,
			data: job.data,
			opts: job.opts,
			timestamp: job.timestamp,
			processedOn: job.processedOn,
			processedBy: job.processedBy,
			finishedOn: job.finishedOn,
			progress: job.progress,
			attempts: job.attemptsMade,
			delay: job.delay,
			failedReason: job.failedReason,
			stacktrace: stacktrace,
			returnValue: job.returnvalue,
			isFailed: !!job.failedReason || (Array.isArray(stacktrace) && stacktrace.length > 0),
		};
	}

	@bindThis
	public async queueGetJob(queueType: QueueType, jobId: string) {
		const queue = this.getQueue(queueType);
		const job = await queue.getJob(jobId);
		if (job != null) {
			return this.packJobData(job);
		} else {
			throw new Error(`Job not found: ${jobId}`);
		}
	}

	@bindThis
	public async queueGetJobLogs(queueType: QueueType, jobId: string) {
		const queue = this.getQueue(queueType);
		const result = await queue.getJobLogs(jobId);
		return result.logs;
	}

	@bindThis
	public async queueGetJobs(queueType: QueueType, jobTypes: JobType[], search?: string) {
		const RETURN_LIMIT = 100;
		const queue = this.getQueue(queueType);
		let jobs: Bull.Job[];

		if (search) {
			jobs = await queue.getJobs(jobTypes, 0, 1000);

			jobs = jobs.filter(job => {
				const jobString = JSON.stringify(job).toLowerCase();
				return search.toLowerCase().split(' ').every(term => {
					return jobString.includes(term);
				});
			});

			jobs = jobs.slice(0, RETURN_LIMIT);
		} else {
			jobs = await queue.getJobs(jobTypes, 0, RETURN_LIMIT);
		}

		return jobs.map(job => this.packJobData(job));
	}

	@bindThis
	public async queueGetQueues() {
		const fetchings = QUEUE_TYPES.map(async type => {
			const queue = this.getQueue(type);

			const counts = await queue.getJobCounts();
			const isPaused = await queue.isPaused();
			const metrics_completed = await queue.getMetrics('completed', 0, MetricsTime.ONE_WEEK);
			const metrics_failed = await queue.getMetrics('failed', 0, MetricsTime.ONE_WEEK);

			return {
				name: type,
				counts: counts,
				isPaused,
				metrics: {
					completed: metrics_completed,
					failed: metrics_failed,
				},
			};
		});

		return await Promise.all(fetchings);
	}

	@bindThis
	public async queueGetQueue(queueType: QueueType) {
		const queue = this.getQueue(queueType);
		const counts = await queue.getJobCounts();
		const isPaused = await queue.isPaused();
		const metrics_completed = await queue.getMetrics('completed', 0, MetricsTime.ONE_WEEK);
		const metrics_failed = await queue.getMetrics('failed', 0, MetricsTime.ONE_WEEK);
		const db = parseRedisInfo(await (await queue.client).info());

		return {
			name: queueType,
			qualifiedName: queue.qualifiedName,
			counts: counts,
			isPaused,
			metrics: {
				completed: metrics_completed,
				failed: metrics_failed,
			},
			db: {
				version: db.redis_version,
				mode: db.redis_mode as 'cluster' | 'standalone' | 'sentinel',
				runId: db.run_id,
				processId: db.process_id,
				port: parseInt(db.tcp_port),
				os: db.os,
				uptime: parseInt(db.uptime_in_seconds),
				memory: {
					total: parseInt(db.total_system_memory) || parseInt(db.maxmemory),
					used: parseInt(db.used_memory),
					fragmentationRatio: parseInt(db.mem_fragmentation_ratio),
					peak: parseInt(db.used_memory_peak),
				},
				clients: {
					connected: parseInt(db.connected_clients),
					blocked: parseInt(db.blocked_clients),
				},
			},
		};
	}
}
