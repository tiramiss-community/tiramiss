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

test('timeline failure is drained and logged while counts, poll and delivery finish independently', async () => {
	const logs: Record<string, unknown>[] = [];
	const finished: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const effects = createNotePostSave(createNotePostSaveWork({
		counts: async () => {
			finished.push('counts');
		},
		schedulePollEnded: async () => {
			finished.push('poll');
		},
		deliver: async () => {
			finished.push('delivery');
		},
		timelines: async () => {
			await gate;
			throw new Error('Redis timeline unavailable');
		},
		currentTime: () => 1000,
	}), createLogger('test', line => logs.push(JSON.parse(line))));
	effects.start({ noteId: 'timeline-note', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: 5000 });
	let closed = false;
	const closing = effects.close().then(() => {
		closed = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(finished.sort()).toEqual(['counts', 'delivery', 'poll']);
	expect(closed).toBe(false);
	release();
	await closing;
	expect(logs).toContainEqual(expect.objectContaining({ event: 'note-post-save.failed', noteId: 'timeline-note', error: expect.objectContaining({ details: { failures: [expect.objectContaining({ step: 'timelines' })] } }) }));
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

test.each(['held', 'reject', 'throw'])('featured starts independently of %s counts and close drains held featured', async mode => {
	let releaseFeatured!: () => void;
	let releaseCounts!: () => void;
	const gate = new Promise<void>(resolve => {
		releaseFeatured = resolve;
	});
	const counts = new Promise<void>(resolve => {
		releaseCounts = resolve;
	});
	const started: string[] = [];
	const logs: string[] = [];
	const effects = createNotePostSave(createNotePostSaveWork({
		counts: () => {
			started.push('counts');
			if (mode === 'throw') {
				throw new Error('count');
			}
			return mode === 'reject' ? Promise.reject(new Error('count')) : counts;
		},
		featured: async () => {
			started.push('featured');
			await gate;
		},
		timelines: async () => {
			started.push('timelines');
		},
		schedulePollEnded: async () => {}, deliver: async () => {
			started.push('deliver');
		}, currentTime: () => 0,
	}), createLogger('test', line => logs.push(line)));
	effects.start({ noteId: 'note', userId: 'user', repliedNoteId: null, renotedNoteId: 'target', channelId: null, pollExpiresAtMs: null });
	let closed = false;
	const close = effects.close().then(() => {
		closed = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(started).toEqual(['counts', 'featured', 'timelines', 'deliver']);
	expect(closed).toBe(false);
	releaseCounts();
	await new Promise(resolve => setImmediate(resolve));
	expect(closed).toBe(false);
	releaseFeatured();
	await close;
	expect(logs.some(line => JSON.parse(line).event === 'note-post-save.failed')).toBe(mode !== 'held');
});

test('synchronous featured failure does not lose started counts or later delivery from the drain', async () => {
	let release!: () => void;
	const blocked = new Promise<void>(resolve => {
		release = resolve;
	});
	const logs: string[] = [];
	const finished: string[] = [];
	const effects = createNotePostSave(createNotePostSaveWork({
		counts: async () => {
			await blocked;
			finished.push('counts');
		},
		featured: () => {
			throw new Error('featured preparation');
		},
		schedulePollEnded: async () => {},
		deliver: async () => {
			finished.push('deliver');
		},
		currentTime: () => 0,
	}), createLogger('test', line => logs.push(line)));
	effects.start({ noteId: 'note', userId: 'user', repliedNoteId: null, renotedNoteId: 'target', channelId: null, pollExpiresAtMs: null });
	let idle = false;
	const waiting = effects.idle().then(() => {
		idle = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(finished).toEqual(['deliver']);
	expect(idle).toBe(false);
	release();
	await waiting;
	expect(finished).toEqual(['deliver', 'counts']);
	expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'note-post-save.failed', error: expect.objectContaining({ details: { failures: [{ step: 'featured', error: { name: 'Error' } }] } }) }));
});

test('hashtags start despite synchronous counts failure, and both idle and close wait for held hashtags', async () => {
	const logs: string[] = [];
	const started: string[] = [];
	let release!: () => void;
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	const effects = createNotePostSave(createNotePostSaveWork({
		counts: () => {
			started.push('counts'); throw new Error('counts');
		},
		hashtags: async () => {
			started.push('hashtags'); await held; throw new Error('hashtag');
		},
		timelines: async () => {
			started.push('timelines');
		},
		deliver: async () => {
			started.push('deliver');
		},
		schedulePollEnded: async () => {}, currentTime: () => 0,
	}), createLogger('test', line => logs.push(line)));
	effects.start({ noteId: 'tagged', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null });
	let idle = false, closed = false;
	const waiting = effects.idle().then(() => {
		idle = true;
	});
	const closing = effects.close().then(() => {
		closed = true;
	});
	await new Promise<void>(resolve => setImmediate(resolve));
	expect(started).toEqual(['counts', 'hashtags', 'timelines', 'deliver']);
	expect([idle, closed]).toEqual([false, false]);
	release();
	await Promise.all([waiting, closing]);
	expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'note-post-save.failed', noteId: 'tagged', error: expect.objectContaining({ details: { failures: [expect.objectContaining({ step: 'counts' }), expect.objectContaining({ step: 'hashtags' })] } }) }));
});
