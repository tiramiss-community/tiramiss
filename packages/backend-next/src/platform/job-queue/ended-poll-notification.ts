/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Queue, Worker } from 'bullmq';
import { DiagnosticError } from '../diagnostic-error.js';
import { baseQueueOptions, baseWorkerOptions, onConnectionEnd, runWorker } from './connection.js';
import type { RedisConfig } from '../../config/types.js';
import type { Logger } from '../logger.js';

export const ENDED_POLL_NOTIFICATION = 'endedPollNotification';

export interface PollEndedJob {
	noteId: string;
}

interface QueueConnection {
	redis: RedisConfig;
	connectTimeoutMs: number;
	logger: Logger;
}

/** 本家 NoteCreateService.postNoteCreated の投入。jobId を付けないため、同じ投稿の重複投入もまとめない。 */
export function pollEndedJobOptions(input: { noteId: string; delayMs: number }) {
	return {
		name: input.noteId,
		data: { noteId: input.noteId } satisfies PollEndedJob,
		// attempts を指定しない本家どおり 1 回だけ実行し、失敗したジョブは保持期間だけ残す。
		opts: {
			delay: input.delayMs,
			removeOnComplete: { age: 3600 * 24 * 7, count: 30 },
			removeOnFail: { age: 3600 * 24 * 7, count: 100 },
		},
	};
}

export function parsePollEndedJob(data: unknown): PollEndedJob {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		throw new DiagnosticError('INVALID_JOB_PAYLOAD', { queue: ENDED_POLL_NOTIFICATION });
	}
	const { noteId } = data as Record<string, unknown>;
	if (typeof noteId !== 'string' || noteId.length === 0) {
		throw new DiagnosticError('INVALID_JOB_PAYLOAD', { queue: ENDED_POLL_NOTIFICATION });
	}
	return { noteId };
}

/** BullMQ の Job から型付きの入力だけを取り出して handle へ渡す。 */
export function createPollEndedProcessor(handle: (job: PollEndedJob) => Promise<void>, logger: Logger) {
	return async (job: { id?: string; name: string; data: unknown; attemptsMade: number }): Promise<void> => {
		try {
			await handle(parsePollEndedJob(job.data));
		} catch (error) {
			// 本家 runQueueJob と同じく試行ごとに記録し、元の例外のまま BullMQ へ返して失敗として残す。
			logger.error('job.failed', { queue: ENDED_POLL_NOTIFICATION, jobId: job.id, jobName: job.name, attemptsMade: job.attemptsMade, error });
			throw error;
		}
	};
}

/** 投票終了ジョブの投入口。ready() を待ってから使い、close() は投入を終えた後に呼ぶ。 */
export function createPollEndedQueue(options: QueueConnection & { onLost(): void }) {
	const queue = new Queue(ENDED_POLL_NOTIFICATION, baseQueueOptions(options.redis, ENDED_POLL_NOTIFICATION, options.connectTimeoutMs));
	let closing = false;
	queue.on('error', error => {
		options.logger.error('job-queue.error', { queue: ENDED_POLL_NOTIFICATION, error });
	});

	return {
		async ready(): Promise<void> {
			await queue.waitUntilReady();
			await onConnectionEnd(queue, () => {
				if (!closing) {
					options.onLost();
				}
			});
		},
		async schedule(input: { noteId: string; delayMs: number }): Promise<void> {
			const job = pollEndedJobOptions(input);
			await queue.add(job.name, job.data, job.opts);
		},
		async close(): Promise<void> {
			closing = true;
			await queue.close();
		},
	};
}

/**
 * 投票終了ジョブの取得を始め、停止関数を返す。停止は取得の停止→実行中のジョブの完了→接続の解放の順に進む。
 * 接続の喪失と取得ループの異常終了は reportFailure へ渡す。
 */
export async function startPollEndedWorker(options: QueueConnection & {
	handle(job: PollEndedJob): Promise<void>;
	reportFailure(error: Error): void;
}): Promise<() => Promise<void>> {
	const worker = new Worker(ENDED_POLL_NOTIFICATION, createPollEndedProcessor(options.handle, options.logger), {
		...baseWorkerOptions(options.redis, ENDED_POLL_NOTIFICATION, options.connectTimeoutMs),
		autorun: false,
	});
	return await runWorker(worker, { queue: ENDED_POLL_NOTIFICATION, logger: options.logger, reportFailure: options.reportFailure });
}
