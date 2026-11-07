/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { planRenoteFeatured } from '../modules/note/public.js';
import { DiagnosticError } from '../platform/diagnostic-error.js';
import type { FeaturedNoteScore, NotePostSaveInput } from '../modules/note/public.js';

export function createPostingFeatured(ports: {
	add(score: FeaturedNoteScore): Promise<void>;
	currentTime(): number;
	random(): number;
	createdAtFromId(id: string): number;
}) {
	return async (input: NotePostSaveInput): Promise<void> => {
		if (input.renotedNoteId === null) {
			return;
		}
		if (!input.createdSnapshot?.renote) {
			throw new DiagnosticError('NOTE_FEATURED_SNAPSHOT_MISSING', { noteId: input.noteId });
		}
		const sample = ports.random();
		// Preserve source short circuit: a failed sample must not parse IDs or read the age clock.
		if (!(sample < 0.3)) {
			return;
		}
		const scores = planRenoteFeatured(input, { sample, now: ports.currentTime(), createdAtMs: ports.createdAtFromId(input.renotedNoteId) });
		const work = scores.map(score => {
			try {
				return ports.add(score);
			} catch (error) {
				return Promise.reject(error);
			}
		});
		const results = await Promise.allSettled(work);
		const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ ...scores[index], error: result.reason }] : []);
		if (failures.length > 0) {
			throw new DiagnosticError('NOTE_FEATURED_FAILED', { failures });
		}
	};
}
