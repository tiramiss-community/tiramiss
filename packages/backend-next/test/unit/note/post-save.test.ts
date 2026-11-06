/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createNotePostSave, createNotePostSaveWork } from '../../../src/platform/note-post-save.js';
import { createLogger } from '../../../src/platform/logger.js';
import { NoteDeliveryError } from '../../../src/modules/federation/public.js';

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
	effects.start({ noteId: 'n1', userId: 'saved', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null });
	effects.start({ noteId: 'n2', userId: 'broken', repliedNoteId: 'replied', renotedNoteId: 'renoted', channelId: 'channel', pollExpiresAtMs: null });
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
			effects.start({ noteId: 'n2', userId: 'second', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null });
		} else {
			await second;
		}
		finished.push(userId);
	}, createLogger('test', () => {}));
	effects.start({ noteId: 'n1', userId: 'first', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null });
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

test('poll enqueue failure is logged with the note and deadline, and does not skip or fail on counts', async () => {
	const logs: string[] = [];
	const counted: string[] = [];
	const effects = createNotePostSave(createNotePostSaveWork({
		counts: async ({ noteId }) => {
			counted.push(noteId);
		},
		schedulePollEnded: async () => {
			throw new Error('queue unavailable');
		},
		deliver: async () => {},
		currentTime: () => 1000,
	}), createLogger('test', line => logs.push(line)));
	effects.start({ noteId: 'n1', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: 61000 });
	await effects.idle();

	expect(counted).toEqual(['n1']);
	expect(logs.map(line => JSON.parse(line)).filter(line => line.event === 'note-post-save.failed')).toEqual([expect.objectContaining({
		noteId: 'n1', userId: 'author', pollExpiresAtMs: 61000,
		error: expect.objectContaining({ code: 'NOTE_POST_SAVE_FAILED', details: { failures: [{ step: 'pollEnded', error: { name: 'Error' } }] } }),
	})]);
});

test('counts failure does not prevent the poll-ended job from being enqueued with the remaining delay', async () => {
	const scheduled: unknown[] = [];
	const work = createNotePostSaveWork({
		counts: async () => {
			throw new Error('count unavailable');
		},
		schedulePollEnded: async job => {
			scheduled.push(job);
		},
		deliver: async () => {},
		currentTime: () => 1000,
	});
	await expect(work({ noteId: 'n1', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: 500 }))
		.rejects.toMatchObject({ code: 'NOTE_POST_SAVE_FAILED', details: { failures: [expect.objectContaining({ step: 'counts' })] } });
	// 期限を過ぎていても本家どおり負の遅延のまま投入する。
	expect(scheduled).toEqual([{ noteId: 'n1', delayMs: -500 }]);
});

test('delivery failure is logged with the note and does not skip counts or the poll-ended job', async () => {
	const logs: string[] = [];
	const done: string[] = [];
	const effects = createNotePostSave(createNotePostSaveWork({
		counts: async ({ noteId }) => {
			done.push(`counts:${noteId}`);
		},
		schedulePollEnded: async ({ noteId }) => {
			done.push(`pollEnded:${noteId}`);
		},
		deliver: async () => {
			throw new NoteDeliveryError('FOLLOWER_INBOX_MISSING', 'inbox is null');
		},
		currentTime: () => 1000,
	}), createLogger('test', line => logs.push(line)));
	effects.start({ noteId: 'n1', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: 61000 });
	await effects.idle();

	expect(done).toEqual(['counts:n1', 'pollEnded:n1']);
	expect(logs.map(line => JSON.parse(line)).filter(line => line.event === 'note-post-save.failed')).toEqual([expect.objectContaining({
		noteId: 'n1', userId: 'author',
		error: expect.objectContaining({ code: 'NOTE_POST_SAVE_FAILED', details: { failures: [{ step: 'deliver', error: { name: 'NoteDeliveryError', code: 'FOLLOWER_INBOX_MISSING' } }] } }),
	})]);
});

test('every saved note is handed to the delivery step, which decides by itself whether to deliver', async () => {
	const delivered: string[] = [];
	const work = createNotePostSaveWork({
		counts: async () => {},
		schedulePollEnded: async () => {},
		deliver: async noteId => {
			delivered.push(noteId);
		},
		currentTime: () => 1000,
	});

	await work({ noteId: 'n1', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: 'channel', pollExpiresAtMs: null });

	expect(delivered).toEqual(['n1']);
});

test('relay signing/submission inside delivery keeps idle and close pending while counts and polls finish, then logs failure', async () => {
	const logs: Record<string, unknown>[] = [];
	const done: string[] = [];
	let release!: () => void;
	const blocked = new Promise<void>(resolve => {
		release = resolve;
	});
	const effects = createNotePostSave(createNotePostSaveWork({
		counts: async () => {
			done.push('counts');
		},
		schedulePollEnded: async () => {
			done.push('poll');
		},
		deliver: async () => {
			done.push('signing');
			await blocked;
			throw new Error('relay enqueue failed');
		},
		currentTime: () => 1000,
	}), createLogger('test', line => logs.push(JSON.parse(line))));
	effects.start({ noteId: 'saved-note', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: 10000 });
	let idle = false;
	let closed = false;
	const waiting = effects.idle().then(() => {
		idle = true;
	});
	const closing = effects.close().then(() => {
		closed = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(done.sort()).toEqual(['counts', 'poll', 'signing']);
	expect([idle, closed]).toEqual([false, false]);
	release();
	await Promise.all([waiting, closing]);
	expect(logs.filter(line => line.event === 'note-post-save.failed')).toEqual([expect.objectContaining({ noteId: 'saved-note', userId: 'author', error: expect.objectContaining({ details: { failures: [{ step: 'deliver', error: { name: 'Error' } }] } }) })]);
});
