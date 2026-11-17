/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { readNotePlan, renderNote } from '../note/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { NoteFacts, NoteFactsReader } from '../note/public.js';

export interface PollRecommendationInput {
	limit: number;
	offset: number;
	excludeChannels: boolean;
}

export interface PollRecommendationReader {
	readAccessFacts(userId: string): Promise<AccessFacts>;
	readPage(input: PollRecommendationInput, viewerId: string, now: number): Promise<{
		roots: NoteFacts[];
		reader: Pick<NoteFactsReader, 'readNotes' | 'readMaterials'>;
	}>;
}

const readInput = compileInput<PollRecommendationInput>({
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		offset: { type: 'integer', default: 0 },
		excludeChannels: { type: 'boolean', default: false },
	},
	required: [],
});

export function createRecommendPolls(reader: PollRecommendationReader) {
	return { async recommendPolls(access: AccessRequest, input: unknown, now: number) {
		const actor = requireCredential(access.credential);
		access.authorize(await reader.readAccessFacts(actor.userId));
		const { roots, reader: notesReader } = await reader.readPage(readInput(input), actor.userId, now);
		const ids = roots.map(note => note.id);
		if (ids.length === 0) {
			return [];
		}
		const selected = new Map(roots.map(note => [note.id, note]));
		const notes = await readNotePlan(ids, async missing => {
			const references = missing.filter(id => !selected.has(id));
			return [...missing.flatMap(id => selected.has(id) ? [selected.get(id)!] : []),
				...(references.length ? await notesReader.readNotes(references) : [])];
		});
		const materials = await notesReader.readMaterials(notes, actor.userId, now);
		return ids.map(id => renderNote(id, materials, actor.userId, now));
	} };
}
