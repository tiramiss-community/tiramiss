/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { planPagination } from '../shared/pagination.js';
import { readNotePlan } from './read-plan.js';
import { renderNote } from './render-note.js';
import type { PaginationInput, PaginationPlan } from '../shared/pagination.js';
import type { NoteFacts, NoteFactsReader } from './model.js';

export interface NotesListInput extends PaginationInput {
	local: boolean;
	reply?: boolean;
	renote?: boolean;
	withFiles?: boolean;
	poll?: boolean;
	limit: number;
}

export interface NotesListReader {
	readPage(input: NotesListInput, pagination: PaginationPlan, guest: boolean): Promise<{
		roots: NoteFacts[];
		reader: Pick<NoteFactsReader, 'readNotes' | 'readMaterials'>;
	}>;
}

export function createListNotes(listReader: NotesListReader, idFromDate: (date: number) => string) {
	return { async listNotes(input: NotesListInput, viewerId: string | null, now: number) {
		const { roots, reader } = await listReader.readPage(input, planPagination(input, idFromDate), viewerId === null);
		const ids = roots.map(note => note.id);
		if (ids.length === 0) {
			return [];
		}
		const selected = new Map(roots.map(note => [note.id, note]));
		const notes = await readNotePlan(ids, async missing => {
			const references = missing.filter(id => !selected.has(id));
			return [
				...missing.flatMap(id => selected.has(id) ? [selected.get(id)!] : []),
				...(references.length ? await reader.readNotes(references) : []),
			];
		});
		// The pinned notes endpoint calls packMany without me, even for authenticated selection.
		const materials = await reader.readMaterials(notes, null, now);
		return ids.map(id => renderNote(id, materials, null, now));
	} };
}
