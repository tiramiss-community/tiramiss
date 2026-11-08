/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createNoteCreateApi } from '../../../src/http/note-create-api.js';
import { createLogger } from '../../../src/platform/logger.js';

function setup(createNote: (render: (noteId: string, viewerId: string) => Promise<unknown>) => Promise<unknown>) {
	const logs: Record<string, unknown>[] = [];
	const app = createNoteCreateApi({
		authenticate: async () => ({ credential: { userId: 'author', native: true } }),
		createNote: async <T>(_actor: unknown, _input: unknown, _now: number, render: (noteId: string, viewerId: string) => Promise<T>) => createNote(render) as Promise<T>,
		readCreatedNote: async () => {
			throw new Error('render failed');
		},
		logger: createLogger('test', line => logs.push(JSON.parse(line))),
	});
	const request = () => app.request('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: 'token', text: 'x' }) });
	return { request, logs };
}

test('a 500 after the Note is saved records the saved Note id, unlike a failure before saving', async () => {
	const rendered = setup(render => render('saved', 'author'));
	const response = await rendered.request();
	expect(response.status).toBe(500);
	expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
	expect(rendered.logs).toEqual([expect.objectContaining({ event: 'note-create.failed', savedNoteId: 'saved' })]);

	const unsaved = setup(async () => {
		throw new Error('insert failed');
	});
	expect((await unsaved.request()).status).toBe(500);
	expect(unsaved.logs).toEqual([expect.objectContaining({ event: 'note-create.failed' })]);
	expect(unsaved.logs[0]).not.toHaveProperty('savedNoteId');
});
