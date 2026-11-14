/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { renderApNote } from '../../../src/modules/federation/public.js';
import { createBackendHttpApp } from '../../../src/composition/http-app.js';
import { testConfig } from '../../helpers/database.js';
import type { RuntimeResources } from '../../../src/composition/create-runtime.js';
import type { NoteActivityMaterials } from '../../../src/modules/federation/public.js';
const materials: NoteActivityMaterials = {
	note: { id: 'at3hjq77note0001', userId: 'alice', createdAtMs: 1793707200000, text: 'hello', cw: null, visibility: 'public', replyId: 'reply', renoteId: null, renoteUserHost: null, fileIds: [], hasPoll: false, tags: [], mentionedRemoteUsers: [] },
	reply: { id: 'reply', uri: null }, renote: null, mentionedUsers: [], files: [], poll: null, emojis: [],
};
// A renderer that leaves default dive=false cannot expose the reply body in featured.
test('default AP Note rendering embeds a prepared local reply', () => {
	const prepared = { ...materials, files: [], audience: { to: [], cc: [] }, tag: [], embeddedReply: { id: 'https://example.test/notes/reply', type: 'Note', inReplyTo: 'https://example.test/notes/inner' }, html: { content: 'hello', noMisskeyContent: true } };
	expect(renderApNote(prepared, { selfUrl: 'https://example.test', now: 1793707200000 }).inReplyTo).toEqual(prepared.embeddedReply);
});
// A route omitted from the ordinary root still returns 404 even when federation is disabled.
test.each(['/users/alice/collections/featured', '/notes/at3hjq77note0001'])('ordinary root exposes %s and checks federation', async (path) => {
	const repository = { find: async () => [{ federation: 'none' }] };
	const resources = {
		instanceAdministration: { updateInstance: vi.fn(), refreshMetadata: vi.fn() }, dataSource: { manager: { getRepository: () => repository } }, logger: { error: vi.fn() }, roleMaterials: { changes: {} }, userHashtags: { start: vi.fn() }, actorInstanceRegistration: { start: vi.fn() }, notePostSave: { start: vi.fn() }, notePostDelete: { start: vi.fn() } } as unknown as RuntimeResources;
	const response = await createBackendHttpApp(resources, testConfig()).request(path, { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(403);
});
