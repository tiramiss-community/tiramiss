/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { planNoteHashtags, canRankHashtag } from '../../../src/modules/note/hashtag-plan.js';
import { createPostingHashtags } from '../../../src/composition/posting-hashtags.js';
import { createHashtagRanking } from '../../../src/platform/hashtag-ranking.js';
import { createNotePostSave, createNotePostSaveWork } from '../../../src/platform/note-post-save.js';
import { createLogger } from '../../../src/platform/logger.js';
import type { NotePostSaveInput, NewNote } from '../../../src/modules/note/public.js';
import type { Redis } from 'ioredis';

const settings = { hiddenTags: [], sensitiveWords: [] };

function input(visibility = 'public', tags = ['a', 'b']): NotePostSaveInput {
	return { noteId: 'note', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null, createdSnapshot: { note: { id: 'note', userId: 'author', userHost: null, tags, visibility, localOnly: true, channelId: 'channel' } as NewNote, reply: null, renote: null } };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
}

test.each(['public', 'home', 'followers', 'specified'])('snapshot gate %s preserves normalized collisions and order', visibility => {
	expect(planNoteHashtags(input(visibility, ['Ａ', 'A', 'B']))).toEqual(['public', 'home'].includes(visibility) ? ['a', 'a', 'b'].map(tag => ({ tag, userId: 'author', userHost: null })) : []);
});
test('missing snapshot is diagnosed', () => {
	expect(() => planNoteHashtags({ ...input(), createdSnapshot: undefined })).toThrow();
});
test.each([
	['Ａ', { hiddenTags: ['a'], sensitiveWords: [] }, false],
	['abc', { hiddenTags: [], sensitiveWords: ['a c'] }, false],
	['abc', { hiddenTags: [], sensitiveWords: ['A'] }, true],
	['abc', { hiddenTags: [], sensitiveWords: ['/A/i'] }, false],
	['abc', { hiddenTags: [], sensitiveWords: ['/[/'] }, true],
] as const)('ranking filter %s %j', (tag, filters, expected) => {
	expect(canRankHashtag(tag, { hiddenTags: [...filters.hiddenTags], sensitiveWords: [...filters.sensitiveWords] })).toBe(expected);
});

test.each(['hold', 'reject', 'throw'])('settings %s never gates DB or other post-save branches; drain waits', async mode => {
	const held = gate();
	const calls: string[] = [];
	const logs: string[] = [];
	const hashtags = createPostingHashtags({ mention: async ({ tag }) => {
		calls.push(`db:${tag}`);
	}, ranking: { update: async ({ tag }) => {
		calls.push(`redis:${tag}`);
	} }, readSettings: () => {
		if (mode === 'throw') {
			throw new Error('settings');
		}
		if (mode === 'reject') {
			return Promise.reject(new Error('settings'));
		}
		return held.promise.then(() => settings);
	} });
	const effects = createNotePostSave(createNotePostSaveWork({ hashtags, counts: async () => {
		calls.push('counts');
	}, deliver: async () => {
		calls.push('deliver');
	}, schedulePollEnded: async () => {}, currentTime: () => 0 }), createLogger('test', line => logs.push(line)));
	effects.start(input());
	let closed = false;
	const closing = effects.close().then(() => {
		closed = true;
	});
	await turn();
	expect(calls).toContain('counts');
	expect(calls).toContain('deliver');
	expect(calls.filter(v => v.startsWith('db:'))).toEqual(['db:a', 'db:b']);
	if (mode === 'hold') {
		expect(closed).toBe(false); held.release();
	}
	await closing;
	expect(calls.filter(v => v.startsWith('redis:'))).toEqual(mode === 'hold' ? ['redis:a', 'redis:b'] : []);
	expect(logs.some(line => line.includes('note-post-save.failed'))).toBe(mode !== 'hold');
});

test('DB failure stops later tags while all started ranking is drained', async () => {
	const held = gate();
	const calls: string[] = [];
	let done = false;
	const run = createPostingHashtags({ mention: async ({ tag }) => {
		calls.push(`db:${tag}`); throw new Error('db');
	}, ranking: { update: async ({ tag }) => {
		calls.push(`redis:${tag}`); await held.promise;
	} }, readSettings: async () => settings })(input());
	const assertion = expect(run).rejects.toMatchObject({ code: 'NOTE_HASHTAGS_FAILED' }).then(() => {
		done = true;
	});
	await turn();
	expect(calls).toEqual(['db:a', 'redis:a']);
	expect(done).toBe(false);
	held.release();
	await assertion;
});

test('held Redis and Redis rejection never block ordered DB progress', async () => {
	const held = gate();
	const db: string[] = [];
	const run = createPostingHashtags({ mention: async ({ tag }) => {
		db.push(tag);
	}, ranking: { update: async ({ tag }) => {
		if (tag === 'a') {
			throw new Error('redis');
		} await held.promise;
	} }, readSettings: async () => settings })(input());
	const assertion = expect(run).rejects.toMatchObject({ code: 'NOTE_HASHTAGS_FAILED' });
	await turn();
	expect(db).toEqual(['a', 'b']);
	held.release();
	await assertion;
});

export function recorder(options: { member?: number; multiFail?: boolean; pipelineError?: boolean; heldMember?: Promise<void> } = {}) {
	const commands: unknown[][] = [];
	const chain = (kind: string) => {
		const result = { zincrby: (...args: unknown[]) => push('zincrby', args), expire: (...args: unknown[]) => push('expire', args), pfadd: (...args: unknown[]) => push('pfadd', args), sadd: (...args: unknown[]) => push('sadd', args), exec: async () => {
			commands.push([kind, 'exec']);
			if (kind === 'multi' && options.multiFail) {
				throw new Error('multi');
			}
			return kind === 'pipeline' ? [[options.pipelineError ? new Error('wrongtype') : null, 1], [null, 1], [null, 1], [null, 1]] : [[null, '1'], [null, 1]];
		} };

		function push(name: string, args: unknown[]) {
			commands.push([name, ...args]); return result;
		}

		commands.push([kind]);
		return result;
	};
	const redis = { sismember: async (...args: unknown[]) => {
		commands.push(['sismember', ...args]); await options.heldMember; return options.member ?? 0;
	}, multi: () => chain('multi'), pipeline: () => chain('pipeline') } as unknown as Redis;
	return { commands, redis };
}

test('separate clocks straddle membership; featured failure still starts pipeline', async () => {
	const held = gate();
	const { commands, redis } = recorder({ multiFail: true, heldMember: held.promise });
	let now = Date.parse('2026-11-07T12:59:59.999Z');
	const run = createHashtagRanking(redis, () => now).update({ tag: 'a', userId: 'u', userHost: null }, settings);
	await turn();
	expect(commands).toEqual([['sismember', 'hashtagUsers:a', 'u']]);
	now = Date.parse('2026-11-07T13:00:00Z'); held.release();
	await expect(run).rejects.toMatchObject({ code: 'NOTE_HASHTAG_REDIS_FAILED' });
	expect(commands).toEqual([
		['sismember', 'hashtagUsers:a', 'u'], ['multi'], ['zincrby', `featuredHashtagsRanking:${Math.floor((now - Date.parse('2023-01-01T00:00Z')) / 3600000)}`, 1, 'a'], ['expire', `featuredHashtagsRanking:${Math.floor((now - Date.parse('2023-01-01T00:00Z')) / 3600000)}`, 10800, 'NX'], ['multi', 'exec'],
		['pipeline'], ['pfadd', 'hashtagUsers:a:202611071250', 'u'], ['expire', 'hashtagUsers:a:202611071250', 259200, 'NX'], ['sadd', 'hashtagUsers:a', 'u'], ['expire', 'hashtagUsers:a', 3600, 'NX'], ['pipeline', 'exec'],
	]);
});
test('membership hit short circuits every write', async () => {
	const { commands, redis } = recorder({ member: 1 });
	await createHashtagRanking(redis, () => 0).update({ tag: 'a', userId: 'u', userHost: null }, settings);
	expect(commands).toEqual([['sismember', 'hashtagUsers:a', 'u']]);
});
test('pipeline command errors are reported', async () => {
	const { redis } = recorder({ pipelineError: true });
	await expect(createHashtagRanking(redis, () => 0).update({ tag: 'a', userId: 'u', userHost: null }, settings)).rejects.toMatchObject({ code: 'NOTE_HASHTAG_REDIS_FAILED' });
});

interface SourceRow {
	id: string; kind: string;
	input: { tags: string[]; nowMs: number; timezone?: string; meta?: typeof settings; user: { id: string; host: string | null }; initial?: unknown; note?: Partial<NewNote>; data?: { visibility: string } };
	calls: { method: string; args?: unknown[]; key?: string; member?: string; result?: number; params?: string[] }[];
}
const oracle: { observations: SourceRow[] } = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/note/hashtag/source-observations.json', import.meta.url), 'utf8'));
for (const row of oracle.observations.filter(row => row.kind === 'update' && !row.input.initial)) {
	test(`fixed source DB mentions and Redis commands: ${row.id}`, async () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = row.input.timezone ?? 'UTC';
		const value = input('public', row.input.tags);
		Object.assign(value.createdSnapshot!.note, { userId: row.input.user.id, userHost: row.input.user.host });
		const members = row.calls.filter(call => call.method === 'sismember');
		const { commands, redis } = recorder();
		redis.sismember = (async (key: string, member: string) => {
			commands.push(['sismember', key, member]);
			return members.shift()!.result!;
		}) as Redis['sismember'];
		const mentions: string[][] = [];
		await createPostingHashtags({ mention: async mention => {
			mentions.push([mention.tag, mention.userId]);
		}, ranking: createHashtagRanking(redis, () => row.input.nowMs), readSettings: async () => ({ ...settings, ...row.input.meta }) })(value);
		expect(mentions).toEqual(row.calls.filter(call => call.method === 'query').map(call => call.params!.slice(0, 2)));
		const expected = row.calls.flatMap(call => call.method === 'sismember' ? [['sismember', call.key, call.member]] : call.args ? [[call.method, ...call.args]] : ['multi', 'pipeline'].includes(call.method) ? [[call.method]] : call.method === 'multi-exec' ? [['multi', 'exec']] : call.method === 'pipeline-exec' ? [['pipeline', 'exec']] : []);
		expect(commands.filter(command => command[0] === 'sismember')).toEqual(expected.filter(command => command[0] === 'sismember'));
		expect(commands.filter(command => command[0] !== 'sismember')).toEqual(expected.filter(command => command[0] !== 'sismember'));
		if (previousTimezone === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = previousTimezone;
		}
	});
}
for (const row of oracle.observations.filter(row => row.kind === 'post' && !row.id.startsWith('post-gate-data-'))) {
	test(`fixed source post gate: ${row.id}`, () => {
		const value = input(row.input.data!.visibility, row.input.tags);
		Object.assign(value.createdSnapshot!.note, row.input.note);
		expect(planNoteHashtags(value).map(mention => [mention.tag, mention.userId])).toEqual(row.calls.filter(call => call.method === 'query').map(call => call.params!.slice(0, 2)));
	});
}

test('held Redis membership does not block DB or siblings, and both idle/close drain it after DB rejection', async () => {
	const held = gate();
	const { commands, redis } = recorder({ heldMember: held.promise });
	const calls: string[] = [];
	const logs: string[] = [];
	const effects = createNotePostSave(createNotePostSaveWork({
		hashtags: createPostingHashtags({
			mention: async ({ tag }) => {
				calls.push(`db:${tag}`); throw new Error('db');
			},
			ranking: createHashtagRanking(redis, () => 1794054896000), readSettings: async () => settings,
		}),
		counts: async () => {
			calls.push('counts');
		}, deliver: async () => {
			calls.push('deliver');
		},
		schedulePollEnded: async () => {}, currentTime: () => 0,
	}), createLogger('test', line => logs.push(line)));
	effects.start(input());
	let idle = false, closed = false;
	const waiting = effects.idle().then(() => {
		idle = true;
	});
	const closing = effects.close().then(() => {
		closed = true;
	});
	await turn();
	expect(calls).toEqual(['counts', 'db:a', 'deliver']);
	expect(commands).toEqual([['sismember', 'hashtagUsers:a', 'author']]);
	expect([idle, closed]).toEqual([false, false]);
	held.release();
	await Promise.all([waiting, closing]);
	expect(commands).toContainEqual(['sadd', 'hashtagUsers:a', 'author']);
	expect(logs.join('')).toContain('NOTE_HASHTAGS_FAILED');
});
