/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { preparePublishedActivity } from '../../../src/composition/published-activity.js';
import type { NotePublicationReader, NotePublicationRow } from '../../../src/modules/federation/public.js';
const options = { selfUrl: 'https://local.test', now: 0, createdAtFromId: () => 0 };
const row: NotePublicationRow = { id: 'note', userId: 'alice', userHost: null, uri: null, localOnly: false, text: null, cw: null, replyId: null, renoteId: 'target', renoteUserHost: null, visibility: 'public', fileIds: [], hasPoll: false, tags: [], mentionedRemoteUsers: 'INVALID JSON', mentions: [], emojis: [] };

function reader(target: NotePublicationRow | null): NotePublicationReader {
	return { readNote: vi.fn(async () => target), authorExists: vi.fn(async () => true), readMentionedUsers: vi.fn(async () => []), readFiles: vi.fn(async () => []), readPoll: vi.fn(async () => null), readEmojis: vi.fn(async () => []) };
}

test('pure local Renote requires a stored target despite legacy delivery URI reconstruction', async () => {
	await expect(preparePublishedActivity(row, reader(null), options)).rejects.toThrow();
});
test.each(['public', 'home'] as const)('pure %s Announce only reads target and skips invalid mention parsing', async visibility => {
	const facts = reader({ ...row, id: 'target', uri: 'https://remote.test/target' });
	const activity = await preparePublishedActivity({ ...row, visibility }, facts, options);
	expect(activity).toMatchObject({ type: 'Announce', object: 'https://remote.test/target', published: '1970-01-01T00:00:00.000Z' });
	expect(activity).not.toHaveProperty('@context');
	expect(facts.readNote).toHaveBeenCalledExactlyOnceWith('target');
	expect(facts.authorExists).not.toHaveBeenCalled();
});
test.each([{ text: '' }, { cw: '' }, { replyId: 'reply' }, { hasPoll: true }, { fileIds: ['file'] }])('quote discriminator %j tolerates missing target and renders bare Create', async extra => {
	const activity = await preparePublishedActivity({ ...row, mentionedRemoteUsers: '[]', ...extra }, reader(null), options);
	expect(activity).toMatchObject({ type: 'Create', object: { type: 'Note' } });
	expect(activity).not.toHaveProperty('@context');
	expect(JSON.parse(JSON.stringify(activity.object))).not.toHaveProperty('quoteUrl');
});
