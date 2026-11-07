/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { createTimelineCache } from '../platform/timeline-cache.js';

export function createPostingRoleTimelines(ports: {
	readRoleIds(userId: string, now: number): Promise<string[]>;
	cache: ReturnType<typeof createTimelineCache>;
	publish(roleId: string, note: Record<string, unknown>): Promise<void>;
	currentTime(): number;
}) {
	return async (noteId: string, userId: string, note: Record<string, unknown>): Promise<void> => {
		const roles = await ports.readRoleIds(userId, ports.currentTime());
		const batch = ports.cache.begin(noteId);
		const work: Promise<void>[] = [];
		try {
			for (const roleId of roles) {
				batch.push({ name: `roleTimeline:${roleId}`, maxlen: 1000 });
				const publication = ports.publish(roleId, note);
				// 本家のdetached publicationを後続roleやpipeline送信を止めずに終了待機へ含める。
				void publication.catch(() => {});
				work.push(publication);
			}
		} catch (error) {
			// 同期的な準備失敗では未送信pipelineを捨て、開始済みの古いID更新とpublicationだけ待つ。
			work.push(batch.drain(), Promise.reject(error));
			await finish(work);
			return;
		}
		work.push(batch.flush());
		await finish(work);
	};
}

async function finish(work: Promise<void>[]): Promise<void> {
	const results = await Promise.allSettled(work);
	const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
	if (errors.length > 0) {
		throw new AggregateError(errors, 'Role timeline update failed');
	}
}
