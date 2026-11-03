/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createNotePostSave } from '../../../src/platform/note-post-save.js';
import { createLogger } from '../../../src/platform/logger.js';

test('post-save failure is logged, does not escape to HTTP, and shutdown waits for started work', async () => {
	const logs: string[] = [];
	let complete!: () => void;
	const blocked = new Promise<void>(resolve => {
		complete = resolve;
	});
	const updated: string[] = [];
	const effects = createNotePostSave(async ({ userId }) => {
		await blocked;
		if (userId === 'broken') {
			throw new Error('count unavailable');
		}
		updated.push(userId);
	}, createLogger('test', line => logs.push(line)));
	effects.start({ noteId: 'n1', userId: 'saved', repliedNoteId: null, renotedNoteId: null, channelId: null });
	effects.start({ noteId: 'n2', userId: 'broken', repliedNoteId: 'replied', renotedNoteId: 'renoted', channelId: 'channel' });
	let closed = false;
	const closing = effects.close().then(() => {
		closed = true;
	});
	await new Promise<void>(resolve => setImmediate(resolve));
	expect(closed).toBe(false);
	complete();
	await closing;
	expect(updated).toEqual(['saved']);
	// 加算の欠けた行を特定できるよう、対象の ID がすべて記録される。
	expect(logs.map(line => JSON.parse(line)).filter(line => line.event === 'note-post-save.failed')).toEqual([expect.objectContaining({
		noteId: 'n2', userId: 'broken', repliedNoteId: 'replied', renotedNoteId: 'renoted', channelId: 'channel',
	})]);
});

test('idle waits for post-save work started while it is waiting', async () => {
	let releaseSecond!: () => void;
	const second = new Promise<void>(resolve => {
		releaseSecond = resolve;
	});
	const finished: string[] = [];
	const effects = createNotePostSave(async ({ userId }) => {
		if (userId === 'first') {
			effects.start({ noteId: 'n2', userId: 'second', repliedNoteId: null, renotedNoteId: null, channelId: null });
		} else {
			await second;
		}
		finished.push(userId);
	}, createLogger('test', () => {}));
	effects.start({ noteId: 'n1', userId: 'first', repliedNoteId: null, renotedNoteId: null, channelId: null });
	let idle = false;
	const waiting = effects.idle().then(() => {
		idle = true;
	});
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	expect(finished).toEqual(['first']);
	expect(idle).toBe(false);
	releaseSecond();
	await waiting;
	expect(finished).toEqual(['first', 'second']);
});
