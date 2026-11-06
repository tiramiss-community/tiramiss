/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createNotePostDelete } from '../../../src/platform/note-post-delete.js';
import { createLogger } from '../../../src/platform/logger.js';
test('accepted deletion work begins before DELETE and is drained even when it fails', async () => {
	let complete!: () => void;
	const blocked = new Promise<void>(resolve => {
		complete = resolve;
	});
	const logs: string[] = [];
	let started = false;
	const tasks = createNotePostDelete(async () => {
		started = true; await blocked; throw new Error('producer failed');
	}, createLogger('test', line => logs.push(line)));
	tasks.start({ kind: 'delivery', snapshot: { id: 'deleted', userId: 'alice' } as never, activity: {} });
	expect(started).toBe(true);
	let closed = false;
	const closing = tasks.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	complete(); await closing;
	expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'note-post-delete.failed', noteId: 'deleted', kind: 'delivery' }));
});
