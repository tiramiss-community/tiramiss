/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { readNotePlan } from '../../../src/modules/note/read-plan.js';
import type { NoteFacts } from '../../../src/modules/note/model.js';

const note = (id: string, replyId: string | null = null, renoteId: string | null = null) => ({ id, replyId, renoteId } as NoteFacts);

test('batches roots and each detail frontier while reusing shared references', async () => {
	const notes = [note('a', 'b', 'c'), note('b', 'a'), note('c', 'b', 'd'), note('d')];
	const batches: string[][] = [];
	const result = await readNotePlan(['a', 'c'], async ids => {
		batches.push([...ids]);
		return notes.filter(n => ids.includes(n.id));
	});
	expect(batches).toEqual([['a', 'c'], ['b', 'd']]);
	expect([...result.keys()]).toEqual(['a', 'c', 'b', 'd']);
});

test('does not expand the reply of a detail:false reply or report its back edge as a cycle', async () => {
	const notes = [note('a', 'b'), note('b', 'a', 'unneeded')];
	const result = await readNotePlan(['a'], async ids => notes.filter(n => ids.includes(n.id)));
	expect([...result.keys()]).toEqual(['a', 'b']);
});

test('promotes a previously shallow reference when later reached as a detailed renote', async () => {
	const notes = [note('a', 'b', 'c'), note('b', 'd'), note('c', null, 'b'), note('d')];
	const result = await readNotePlan(['a'], async ids => notes.filter(n => ids.includes(n.id)));
	expect([...result.keys()]).toEqual(['a', 'b', 'c', 'd']);
});

test('fails on detailed cycles and budget exhaustion instead of returning partial success', async () => {
	const notes = [note('a', null, 'b'), note('b', null, 'a')];
	await expect(readNotePlan(['a'], async ids => notes.filter(n => ids.includes(n.id)))).rejects.toThrow('NOTE_REFERENCE_CYCLE');
	await expect(readNotePlan(['a'], async ids => notes.filter(n => ids.includes(n.id)), { maxNotes: 1, maxDepth: 64 })).rejects.toThrow('NOTE_READ_BUDGET');
});

test('enforces depth budget on a long acyclic renote chain', async () => {
	const notes = Array.from({ length: 66 }, (_, i) => note(String(i), null, i < 65 ? String(i + 1) : null));
	await expect(readNotePlan(['0'], async ids => notes.filter(n => ids.includes(n.id)))).rejects.toThrow('NOTE_READ_BUDGET');
});
