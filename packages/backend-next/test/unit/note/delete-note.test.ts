/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createDeleteNote } from '../../../src/modules/note/delete-note.js';
import type { DeletedNoteSnapshot, NoteDeleteWork } from '../../../src/modules/note/delete-note.js';

const note: DeletedNoteSnapshot = {
	id: 'note1', userId: 'author', authorHost: null, localOnly: false, replyId: 'parent',
	note: { id: 'note1', userId: 'author', createdAtMs: 1000, text: 'text', cw: null, visibility: 'specified', replyId: 'parent', renoteId: null, renoteUserHost: null, fileIds: [], hasPoll: false, tags: [], mentionedRemoteUsers: [] },
	renote: null, renoteUserId: null, auditNote: { id: 'note1', text: 'text' }, authorUsername: 'alice',
};

function setup(options: { moderator?: boolean; suspended?: boolean; exists?: boolean; failDelete?: boolean; failRender?: boolean; failOriginal?: boolean; actorMissing?: boolean; snapshot?: Partial<DeletedNoteSnapshot> } = {}) {
	const events: string[] = [];
	const work: NoteDeleteWork[] = [];
	const useCase = createDeleteNote({
		readActor: async () => options.actorMissing ? null : ({ isSuspended: options.suspended ?? false, rateLimitFactor: 1, isModerator: options.moderator ?? false }),
		limit: async () => {
			events.push('limit');
		},
		readNote: async () => options.exists === false ? null : { ...note, ...options.snapshot },
		readRenote: async () => {
			events.push('original');
			if (options.failOriginal) {
				throw new Error('original query');
			}
			return { id: 'original', uri: null };
		},
		decrementReplies: async () => {
			events.push('reply');
		},
		publishDeleted: () => {
			events.push('published');
		},
		renderActivity: () => {
			if (options.failRender) {
				throw new Error('render');
			} return { type: 'Delete' };
		},
		start: input => {
			work.push(input); events.push(input.kind);
		},
		deleteNote: async () => {
			events.push('delete'); if (options.failDelete) {
				throw new Error('db');
			}
		},
	});
	return { ...useCase, events, work };
}

const actor = { userId: 'author', native: true } as const;
const unscoped = { userId: 'author', native: false, permissions: new Set<string>() } as const;
test('author deletion decrements reply, starts delivery before delete, and does not audit', async () => {
	const world = setup();
	await world.deleteNote(actor, { noteId: 'note1' }, 10000);
	expect(world.events).toEqual(['limit', 'reply', 'published', 'delivery', 'search', 'delete']);
	expect(world.work[0]).toMatchObject({ kind: 'delivery', snapshot: note, activity: { type: 'Delete' } });
});
test('moderator audit starts only after successful deletion and retains original author', async () => {
	const world = setup({ moderator: true });
	await world.deleteNote({ ...actor, userId: 'moderator' }, { noteId: 'note1' }, 10000);
	expect(world.events).toEqual(['limit', 'reply', 'published', 'delivery', 'search', 'delete', 'audit']);
	expect(world.work[2]).toMatchObject({ kind: 'audit', actorId: 'moderator', snapshot: { userId: 'author', auditNote: note.auditNote } });
});
test('failed DELETE does not pretend the earlier decrement or delivery was rolled back', async () => {
	const world = setup({ moderator: true, failDelete: true });
	await expect(world.deleteNote({ ...actor, userId: 'moderator' }, { noteId: 'note1' }, 10000)).rejects.toThrow('db');
	expect(world.events).toEqual(['limit', 'reply', 'published', 'delivery', 'search', 'delete']);
});
test('synchronous rendering failure precedes local deletion', async () => {
	const world = setup({ failRender: true });
	await expect(world.deleteNote(actor, { noteId: 'note1' }, 10000)).rejects.toThrow('render');
	expect(world.events).toEqual(['limit', 'reply', 'published']);
});
test.each([
	[null, {}, {}, 'CREDENTIAL_REQUIRED'],
	[actor, {}, { suspended: true }, 'YOUR_ACCOUNT_SUSPENDED'],
	[unscoped, {}, {}, 'PERMISSION_DENIED'],
	[actor, {}, {}, 'INVALID_PARAM'],
	[actor, { noteId: 'note1' }, { exists: false }, 'NO_SUCH_NOTE'],
	[{ ...actor, userId: 'other' }, { noteId: 'note1' }, {}, 'ACCESS_DENIED'],
] as const)('rejects invalid or unauthorized deletion %#', async (who, input, options, code) => {
	const world = setup(options);
	await expect(world.deleteNote(who, input, 10000)).rejects.toMatchObject({ code });
	expect(world.events).not.toContain('delete');
});

test('missing authenticated actor is rejected and localOnly/remote authors do not start AP work', async () => {
	await expect(setup({ actorMissing: true }).deleteNote(actor, { noteId: 'note1' }, 10000)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
	for (const snapshot of [{ localOnly: true }, { authorHost: 'remote.test' }]) {
		const world = setup({ snapshot });
		await world.deleteNote(actor, { noteId: 'note1' }, 10000);
		expect(world.events).toEqual(['limit', 'reply', 'published', ...(snapshot.authorHost ? ['instanceCounts'] : []), 'search', 'delete']);
	}
});

test('remote instance count work starts before search and failed DELETE and keeps original host', async () => {
	const world = setup({ failDelete: true, snapshot: { authorHost: 'remote.test' } });
	await expect(world.deleteNote(actor, { noteId: 'note1' }, 10000)).rejects.toThrow('db');
	expect(world.events).toEqual(['limit', 'reply', 'published', 'instanceCounts', 'search', 'delete']);
	expect(world.work[0]).toMatchObject({ kind: 'instanceCounts', snapshot: { authorHost: 'remote.test' } });
});

const pureRenote = { ...note.note, text: null, replyId: null, renoteId: 'original' };
test('pure Renote original query failure follows deleted publication and prevents later effects', async () => {
	const world = setup({ failOriginal: true, snapshot: { replyId: null, note: pureRenote } });
	await expect(world.deleteNote(actor, { noteId: 'note1' }, 10000)).rejects.toThrow('original query');
	expect(world.events).toEqual(['limit', 'published', 'original']);
	expect(world.work).toEqual([]);
});
test('pure Renote original is prepared after publication without mutating the published snapshot', async () => {
	const world = setup({ snapshot: { replyId: null, note: pureRenote } });
	await world.deleteNote(actor, { noteId: 'note1' }, 10000);
	expect(world.events).toEqual(['limit', 'published', 'original', 'delivery', 'search', 'delete']);
	expect(world.work[0]).toMatchObject({ kind: 'delivery', snapshot: { renote: { id: 'original', uri: null } } });
	expect(world.work[1]).toMatchObject({ kind: 'search', snapshot: { renote: null } });
});
test.each([
	{ localOnly: true, note: pureRenote },
	{ authorHost: 'remote.test', note: pureRenote },
	{ note: note.note },
	{ note: { ...pureRenote, text: 'quote' } },
])('original query is skipped for a deletion without pure local AP work %#', async snapshot => {
	const world = setup({ failOriginal: true, snapshot });
	await world.deleteNote(actor, { noteId: 'note1' }, 10000);
	expect(world.events).not.toContain('original');
	expect(world.events).toContain('delete');
});
test('denied pure Renote deletion does not read the original', async () => {
	const world = setup({ failOriginal: true, snapshot: { replyId: null, note: pureRenote } });
	await expect(world.deleteNote({ ...actor, userId: 'other' }, { noteId: 'note1' }, 10000)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
	expect(world.events).toEqual(['limit']);
});
