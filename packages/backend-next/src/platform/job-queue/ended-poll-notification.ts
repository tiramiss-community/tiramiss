/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from '../diagnostic-error.js';
import type { JobHandler } from '@mokurokujs/core';
import type { Logger } from '../logger.js';

export const ENDED_POLL_NOTIFICATION = 'endedPollNotification';

export interface PollEndedJob {
	noteId: string;
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

/** 保存済み payload を検証して handle へ渡す。 */
export function createPollEndedProcessor(handle: (job: PollEndedJob) => Promise<void>, logger: Logger): JobHandler<PollEndedJob, void> {
	return async (payload, context) => {
		try {
			await handle(parsePollEndedJob(payload));
		} catch (error) {
			// 本家 runQueueJob と同じく試行ごとに記録し、元の例外のまま BullMQ へ返して失敗として残す。
			logger.error('job.failed', { queue: ENDED_POLL_NOTIFICATION, jobId: context.jobId, jobName: context.jobName, attemptsMade: context.attempt - 1, error });
			throw error;
		}
	};
}
