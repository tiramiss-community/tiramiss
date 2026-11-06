/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createDeliverDeletedNote, renderDeletedNoteActivity } from '../../../src/modules/federation/note-deletion.js';
import type { NoteActivityNote } from '../../../src/modules/federation/public.js';
const note: NoteActivityNote = { id: 'note1', userId: 'alice', createdAtMs: 1000, text: 'text', cw: null, visibility: 'specified', replyId: null, renoteId: null, renoteUserHost: null, fileIds: [], hasPoll: false, tags: [], mentionedRemoteUsers: [] };
const options = { selfUrl: 'https://local.test', now: 2000, randomId: 'random-delete-id', isLocalUri: () => true };
test('Delete has Tombstone, explicit timestamp and random id, without outer audience', () => {
	const activity = renderDeletedNoteActivity({ note, renote: null }, options);
	expect(activity).toMatchObject({ id: 'https://local.test/random-delete-id', type: 'Delete', actor: 'https://local.test/users/alice', object: { id: 'https://local.test/notes/note1', type: 'Tombstone' }, published: new Date(2000).toISOString() });
	expect(activity).not.toHaveProperty('to'); expect(activity).not.toHaveProperty('cc');
});
test('pure renote Undo embeds original Announce audience and own creation time', () => {
	const activity = renderDeletedNoteActivity({ note: { ...note, text: null, renoteId: 'original', visibility: 'home' }, renote: { id: 'original', uri: 'https://remote.test/n/1' } }, options);
	expect(activity).toMatchObject({ id: 'https://local.test/notes/note1/activity/undo', type: 'Undo', object: { id: 'https://local.test/notes/note1/activity', type: 'Announce', object: 'https://remote.test/n/1', published: new Date(1000).toISOString(), to: ['https://local.test/users/alice/followers'], cc: ['https://www.w3.org/ns/activitystreams#Public'] } });
	expect(activity).not.toHaveProperty('to');
});
test('missing original falls back to Delete and nonlocal Announce id gets random Undo id', () => {
	const pure = { ...note, text: null, renoteId: 'original', visibility: 'public' as const };
	expect(renderDeletedNoteActivity({ note: pure, renote: null }, options).type).toBe('Delete');
	expect(renderDeletedNoteActivity({ note: pure, renote: { id: 'original', uri: null } }, { ...options, isLocalUri: () => false }).id).toBe('https://local.test/random-delete-id');
});
test.each([{ cw: '' }, { replyId: 'reply' }, { hasPoll: true }, { fileIds: ['file'] }, { text: '' }])('quote condition %j keeps Delete', fields => {
	expect(renderDeletedNoteActivity({ note: { ...note, text: null, renoteId: 'original', ...fields }, renote: { id: 'original', uri: null } }, options).type).toBe('Delete');
});
test('specified pure Renote with original fails before producing an activity', () => {
	expect(() => renderDeletedNoteActivity({ note: { ...note, text: null, renoteId: 'original' }, renote: { id: 'original', uri: null } }, options)).toThrow('non-public');
});
test('deletion keeps follower/direct/relay independent even at overlapping shared inbox', async () => {
	const sent: { branch: string; inboxes?: [string, boolean][] }[] = [];
	const deliver = createDeliverDeletedNote({
		readFollowerInboxes: async () => [{ followerInbox: 'https://remote.test/users/follower/inbox', followerSharedInbox: 'https://remote.test/inbox' }],
		readConcernedUsers: async () => [{ id: 'direct', host: 'remote.test', inbox: 'https://remote.test/users/direct/inbox', sharedInbox: 'https://remote.test/inbox' }],
		enqueue: async batch => {
			sent.push({ branch: 'normal', inboxes: [...batch.inboxes] });
		},
		deliverToRelays: async () => {
			sent.push({ branch: 'relay' });
		},
	});
	await deliver({ snapshot: { id: 'note1', userId: 'alice' } as never, activity: { type: 'Delete' } });
	expect(sent).toContainEqual({ branch: 'normal', inboxes: [['https://remote.test/inbox', true]] });
	expect(sent).toContainEqual({ branch: 'normal', inboxes: [['https://remote.test/users/direct/inbox', false]] });
	expect(sent).toContainEqual({ branch: 'relay' });
});

test.each(['followers', 'relay', 'direct'])('failed %s branch does not suppress the other deletion branches', async failing => {
	const branches: string[] = [];
	const fail = async (branch: string) => {
		branches.push(branch);
		if (failing === branch) {
			throw new Error(branch);
		}
	};
	const deliver = createDeliverDeletedNote({
		readFollowerInboxes: async () => {
			await fail('followers'); return [];
		},
		readConcernedUsers: async () => {
			await fail('direct'); return [];
		},
		deliverToRelays: async () => {
			await fail('relay');
		},
		enqueue: async () => {},
	});
	await expect(deliver({ snapshot: { id: 'note1', userId: 'alice' }, activity: {} })).rejects.toThrow(failing);
	expect(branches.sort()).toEqual(['direct', 'followers', 'relay']);
});
