/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import type { NotePersonalStatePorts } from '../../../src/modules/note-personal-state/public.js';
import { createNotePersonalState } from '../../../src/modules/note-personal-state/public.js';

function setup() {
	const favorite = new Set<string>();
	const mute = new Set<string>();
	const ports: NotePersonalStatePorts = {
		readActor: async () => ({ isSuspended: false, isModerator: false, isAdministrator: false, movedToUri: null, rateLimitFactor: 1 }),
		readNote: async (id: string) => id === 'missing' ? null : ({ id, threadId: id === 'reply' ? 'root' : null, userId: 'author', userHost: null, visibility: 'public' as const, visibleUserIds: [], replyUserId: null, mentions: [] }),
		isFollowing: async () => false,
		hasFavorite: async (userId: string, id: string) => favorite.has(`${userId}:${id}`),
		readFavorite: async (userId, id) => favorite.has(`${userId}:${id}`) ? { id: `${userId}:${id}` } : null,
		hasThreadMute: async (userId: string, id: string) => mute.has(`${userId}:${id}`),
		insertFavorite: async (row: { userId: string; noteId: string }) => {
 favorite.add(`${row.userId}:${row.noteId}`); 
},
		deleteFavorite: async (id: string) => {
 favorite.delete(id); 
},
		insertThreadMute: async (row: { userId: string; threadId: string }) => {
 mute.add(`${row.userId}:${row.threadId}`); 
},
		deleteThreadMute: async (userId: string, id: string) => {
 mute.delete(`${userId}:${id}`); 
},
		limit: vi.fn(async () => {}), newId: () => 'newid',
		startAchievement: vi.fn(),
	};
	const access = () => createAccessRequest({ requireCredential: true }, { userId: 'viewer', native: true });
	return { ports, favorite, mute, access, app: createNotePersonalState(ports) };
}

test('favorites persist per viewer and duplicate/unfavorite retry preserve endpoint errors', async () => {
	const { app, access, ports, favorite } = setup();
	await app.execute('favorites/create', access(), { noteId: 'root' }, 100);
	expect(favorite.has('viewer:root')).toBe(true);
	expect(ports.startAchievement).toHaveBeenCalledWith('author');
	await expect(app.execute('favorites/create', access(), { noteId: 'root' }, 100)).rejects.toMatchObject({ code: 'ALREADY_FAVORITED', id: 'a402c12b-34dd-41d2-97d8-4d2ffd96a1a6' });
	await app.execute('favorites/delete', access(), { noteId: 'root' }, 100);
	expect(favorite.size).toBe(0);
	await expect(app.execute('favorites/delete', access(), { noteId: 'root' }, 100)).rejects.toMatchObject({ code: 'NOT_FAVORITED' });
});

test('thread mute uses root id for replies and note id for root, delete is idempotent', async () => {
	const { app, access, mute } = setup();
	await app.execute('thread-muting/create', access(), { noteId: 'reply' }, 100);
	expect([...mute]).toEqual(['viewer:root']);
	await expect(app.execute('thread-muting/create', access(), { noteId: 'root' }, 100)).rejects.toMatchObject({ code: 'ALREADY_MUTING' });
	await app.execute('thread-muting/delete', access(), { noteId: 'root' }, 100);
	await app.execute('thread-muting/delete', access(), { noteId: 'reply' }, 100);
	expect(mute.size).toBe(0);
});

test('only favorite create checks visibility and moved account status', async () => {
	const { app, access, ports } = setup();
	ports.readNote = async id => ({ id, threadId: null, userId: 'author', userHost: null, visibility: 'specified', visibleUserIds: [], replyUserId: null, mentions: [] });
	await expect(app.execute('favorites/create', access(), { noteId: 'private' }, 100)).rejects.toMatchObject({ code: 'NO_SUCH_NOTE' });
	await app.execute('thread-muting/create', access(), { noteId: 'private' }, 100);
	ports.readActor = async () => ({ isSuspended: false, isModerator: false, isAdministrator: false, movedToUri: 'https://remote', rateLimitFactor: 1 });
	await expect(app.execute('favorites/create', access(), { noteId: 'private' }, 100)).rejects.toMatchObject({ code: 'YOUR_ACCOUNT_MOVED' });
	await app.execute('thread-muting/delete', access(), { noteId: 'private' }, 100);
});

test('creation limits run before current account authorization and deletion never consumes a limit', async () => {
	const { app, access, ports } = setup();
	ports.readActor = async () => ({ isSuspended: true, isModerator: false, isAdministrator: false, movedToUri: null, rateLimitFactor: 2 });
	await expect(app.execute('favorites/create', access(), {}, 100)).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
	expect(ports.limit).toHaveBeenCalledWith('favorites/create', 'viewer', 2);
	vi.mocked(ports.limit).mockClear();
	await expect(app.execute('favorites/delete', access(), {}, 100)).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
	expect(ports.limit).not.toHaveBeenCalled();
});
