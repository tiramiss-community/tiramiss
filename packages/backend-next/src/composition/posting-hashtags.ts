/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { planNoteHashtags } from '../modules/note/public.js';
import { DiagnosticError } from '../platform/diagnostic-error.js';
import type { HashtagMention, HashtagRankingSettings, NotePostSaveInput } from '../modules/note/public.js';

export function createPostingHashtags(ports: {
	mention(input: HashtagMention): Promise<void>;
	ranking: { update(input: HashtagMention, settings: HashtagRankingSettings): Promise<void> };
	readSettings(): Promise<HashtagRankingSettings>;
}) {
	return async (input: NotePostSaveInput): Promise<void> => {
		if (!input.createdSnapshot) {
			throw new DiagnosticError('NOTE_HASHTAG_SNAPSHOT_MISSING', { noteId: input.noteId });
		}
		const mentions = planNoteHashtags(input);
		if (mentions.length === 0) {
			return;
		}
		const failures: { step: string; tag?: string; error: unknown }[] = [];
		// Unlike the source's injected Meta, this read is asynchronous. It must never gate DB progress.
		const settings = (() => {
			try {
				return ports.readSettings();
			} catch (error) {
				return Promise.reject(error);
			}
		})();
		void settings.catch(() => {});
		const rankings: Promise<void>[] = [];
		for (const mention of mentions) {
			// Attach the handler immediately, before an ordered DB write can suspend this loop.
			rankings.push(settings.then(value => ports.ranking.update(mention, value)).catch(error => {
				failures.push({ step: 'ranking', tag: mention.tag, error });
			}));
			try {
				await ports.mention(mention);
			} catch (error) {
				failures.push({ step: 'mention', tag: mention.tag, error });
				break;
			}
		}
		await Promise.all(rankings);
		if (failures.length > 0) {
			throw new DiagnosticError('NOTE_HASHTAGS_FAILED', { failures });
		}
	};
}
