/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteFacts } from './model.js';

export async function readNotePlan(
	rootIds: readonly string[],
	read: (ids: readonly string[]) => Promise<NoteFacts[]>,
	budget = { maxDepth: 64, maxNotes: 256 },
): Promise<Map<string, NoteFacts>> {
	const notes = new Map<string, NoteFacts>();
	const fetched = new Set<string>();
	const expanded = new Set<string>();
	let frontier = [...new Set(rootIds)].map(id => ({ id, detail: true }));
	while (frontier.length > 0) {
		const missing = [...new Set(frontier.map(x => x.id))].filter(id => !fetched.has(id));
		if (fetched.size + missing.length > budget.maxNotes) {
			throw new Error('NOTE_READ_BUDGET');
		}
		if (missing.length > 0) {
			for (const id of missing) {
				fetched.add(id);
			}
			for (const note of await read(missing)) {
				notes.set(note.id, note);
			}
		}
		const next: typeof frontier = [];
		for (const { id, detail } of frontier) {
			const note = notes.get(id);
			if (!note || !detail || expanded.has(id)) {
				continue;
			}
			expanded.add(id);
			if (note.replyId) {
				next.push({ id: note.replyId, detail: false });
			}
			if (note.renoteId) {
				next.push({ id: note.renoteId, detail: true });
			}
		}
		frontier = next;
	}

	const heights = new Map<string, number>();
	const visiting = new Set<string>();
	const height = (id: string): number => {
		if (!notes.has(id)) {
			return 0;
		}
		if (visiting.has(id)) {
			throw new Error('NOTE_REFERENCE_CYCLE');
		}
		const cached = heights.get(id);
		if (cached !== undefined) {
			return cached;
		}
		visiting.add(id);
		if (visiting.size > budget.maxDepth) {
			throw new Error('NOTE_READ_BUDGET');
		}
		const note = notes.get(id)!;
		const value = 1 + Math.max(note.replyId && notes.has(note.replyId) ? 1 : 0, note.renoteId ? height(note.renoteId) : 0);
		visiting.delete(id);
		if (value > budget.maxDepth) {
			throw new Error('NOTE_READ_BUDGET');
		}
		heights.set(id, value);
		return value;
	};
	for (const id of rootIds) {
		height(id);
	}
	return notes;
}
