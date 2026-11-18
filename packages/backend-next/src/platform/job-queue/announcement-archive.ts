/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from '../diagnostic-error.js';
import { writeWorkerLog } from './worker-logging.js';
import type { JobHandler } from '@mokurokujs/core';
import type { Logger } from '../logger.js';

export const SYSTEM = 'system';
export const ARCHIVE_ANNOUNCEMENT = 'archiveAnnouncement';
export interface AnnouncementArchiveJob {
	announcementId: string;
	autoArchiveAt: number;
}

export function announcementArchiveJob(announcementId: string, autoArchiveAt: Date, now: number) {
	return {
		data: { announcementId, autoArchiveAt: autoArchiveAt.getTime() } satisfies AnnouncementArchiveJob,
		opts: {
			jobId: `archiveAnnouncement-${announcementId}-${autoArchiveAt.getTime()}`,
			delay: Math.max(0, autoArchiveAt.getTime() - now),
			removeOnComplete: { age: 3600 * 24 * 7, count: 30 },
			removeOnFail: { age: 3600 * 24 * 7, count: 100 },
		},
	};
}

export function parseAnnouncementArchiveJob(data: unknown): AnnouncementArchiveJob {
	if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
		const { announcementId, autoArchiveAt } = data as Record<string, unknown>;
		if (typeof announcementId === 'string' && announcementId.length > 0 && typeof autoArchiveAt === 'number' && Number.isFinite(new Date(autoArchiveAt).getTime())) {
			return { announcementId, autoArchiveAt };
		}
	}
	throw new DiagnosticError('INVALID_JOB_PAYLOAD', { queue: SYSTEM });
}

export function createAnnouncementArchiveProcessor(archive: (id: string, autoArchiveAt: Date) => Promise<boolean>, logger: Logger): JobHandler<AnnouncementArchiveJob, void> {
	return async (payload, context) => {
		try {
			const job = parseAnnouncementArchiveJob(payload);
			const archived = await archive(job.announcementId, new Date(job.autoArchiveAt));
			writeWorkerLog(() => {
				if (archived) {
					logger.info('announcement.archived', { announcementId: job.announcementId });
				} else {
					logger.debug?.('announcement.archive-unmatched', { announcementId: job.announcementId });
				}
			});
		} catch (error) {
			writeWorkerLog(() => logger.error('job.failed', { queue: SYSTEM, jobId: context.jobId, jobName: context.jobName, attemptsMade: context.attempt - 1, error }));
			throw error;
		}
	};
}
