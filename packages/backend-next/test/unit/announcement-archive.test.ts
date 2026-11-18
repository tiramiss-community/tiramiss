/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createAnnouncementArchives } from '../../src/modules/announcement/public.js';
import { announcementArchiveJob, createAnnouncementArchiveProcessor, parseAnnouncementArchiveJob } from '../../src/platform/job-queue/announcement-archive.js';

const now = new Date('2026-11-18T00:00:00.000Z');

test('restoration propagates query and enqueue failures and passes the saved deadline unchanged', async () => {
	const rows = [{ announcementId: 'one', autoArchiveAt: now }, { announcementId: 'two', autoArchiveAt: new Date(now.getTime() + 1) }];
	const failure = new Error('enqueue');
	const scheduled: unknown[] = [];
	const archives = createAnnouncementArchives({
		reservations: async () => rows,
		schedule: async (announcementId, autoArchiveAt) => {
			scheduled.push({ announcementId, autoArchiveAt });
			if (announcementId === 'one') {
				throw failure;
			}
		},
		archive: async () => false,
		now: () => now,
	});
	await expect(archives.restore()).rejects.toBe(failure);
	expect(scheduled).toEqual(rows);
});

test('producer identity includes the exact date, clamps expired delays and keeps upstream retention without automatic retry', () => {
	for (const [offset, delay] of [[-1000, 0], [0, 0], [1000, 1000]]) {
		const date = new Date(now.getTime() + offset);
		expect(announcementArchiveJob('id', date, now.getTime())).toEqual({
			data: { announcementId: 'id', autoArchiveAt: date.getTime() },
			opts: { jobId: `archiveAnnouncement-id-${date.getTime()}`, delay, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } },
		});
	}
});

test.each([null, [], {}, { announcementId: 'id' }, { announcementId: '', autoArchiveAt: 0 }, { announcementId: 'id', autoArchiveAt: '2026-11-18' }, { announcementId: 'id', autoArchiveAt: Infinity }, { announcementId: 'id', autoArchiveAt: 9e15 }])('rejects malformed stored archive payload %j', input => {
	expect(() => parseAnnouncementArchiveJob(input)).toThrow(expect.objectContaining({ code: 'INVALID_JOB_PAYLOAD' }));
});

test('valid persisted payload is processed with explicit time, failure is retained and diagnostic failure cannot change success', async () => {
	const ports = { reservations: async () => [], schedule: async () => {}, archive: vi.fn(async () => true), now: () => now };
	const archives = createAnnouncementArchives(ports);
	const logger = { info: () => {
		throw Error('logger'); 
	}, debug: () => {
		throw Error('logger'); 
	}, error: vi.fn() };
	const process = createAnnouncementArchiveProcessor(archives.archive, logger);
	const payload = { announcementId: 'id', autoArchiveAt: now.getTime() };
	const context = { jobId: 'job', jobName: 'archiveAnnouncement', attempt: 2, timestamp: now, signal: new AbortController().signal };
	await expect(process(payload, context)).resolves.toBeUndefined();
	expect(ports.archive).toHaveBeenCalledWith('id', now, now);
	const failure = Error('database');
	ports.archive.mockRejectedValueOnce(failure);
	await expect(process(payload, context)).rejects.toBe(failure);
	expect(logger.error).toHaveBeenCalledWith('job.failed', expect.objectContaining({ queue: 'system', attemptsMade: 1, error: failure }));
});
