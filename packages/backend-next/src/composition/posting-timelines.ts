/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { planNoteTimelines, sampleTimelineFollowers } from '../modules/note/public.js';
import type { NotePostSaveInput, TimelineMaterials } from '../modules/note/public.js';
import type { createNoteTimelineReader } from '../platform/database/note-timelines.js';
import type { createTimelineCache } from '../platform/timeline-cache.js';

export function createPostingTimelines(ports: {
	reader: ReturnType<typeof createNoteTimelineReader>;
	cache: ReturnType<typeof createTimelineCache>;
	currentTime(): number;
	random(): number;
}) {
	return async (input: NotePostSaveInput): Promise<void> => {
		const settings = await ports.reader.settings();
		if (!settings.enabled) {
			return;
		}
		const note = input.createdSnapshot?.note ?? await ports.reader.note(input.noteId);
		if (note === null) {
			return;
		}
		const materials: TimelineMaterials = { limits: settings.limits, followers: [], lists: [], channelFollowers: [] };
		const batch = ports.cache.begin(note.id);
		try {
			if (note.channelId) {
				// 本家はchannel followerの照会より先にこの2系統を準備する。
				// 古いIDの直接更新は照会失敗でも残り、recentのpipelineはそのとき送信しない。
				for (const entry of planNoteTimelines(note, materials)) {
					batch.push(entry);
				}
				materials.channelFollowers = await ports.reader.channelFollowers(note.channelId);
				for (const entry of planNoteTimelines(note, materials).slice(2)) {
					batch.push(entry);
				}
			} else {
				[materials.followers, materials.lists] = await Promise.all([ports.reader.followers(note.userId), ports.reader.lists(note.userId)]);
				for (const entry of planNoteTimelines(note, materials)) {
					batch.push(entry);
				}
			}
		} catch (error) {
			try {
				await batch.drain();
			} catch (drainError) {
				throw new AggregateError([error, drainError], 'Timeline preparation and direct update failed');
			}
			throw error;
		}
		const work = [batch.flush()];
		if (!note.channelId && ports.random() < 0.1) {
			const ids = sampleTimelineFollowers(materials.followers.map(follower => follower.followerId), ports.random);
			work.push(Promise.resolve().then(() => ports.reader.hibernate(ids, ports.currentTime())));
		}
		const results = await Promise.allSettled(work);
		const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Note timeline update failed');
		}
	};
}
