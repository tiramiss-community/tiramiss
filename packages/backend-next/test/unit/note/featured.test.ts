/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { planRenoteFeatured } from '../../../src/modules/note/featured-plan.js';
import { createPostingFeatured } from '../../../src/composition/posting-featured.js';
import { createFeaturedRanking } from '../../../src/platform/featured-ranking.js';
import type { NotePostSaveInput, RelatedNote, NewNote, FeaturedNoteScore } from '../../../src/modules/note/public.js';
import type { Redis } from 'ioredis';

const target: RelatedNote = { id: '1793968496000', userId: 'target-author', userHost: null, text: 'target', cw: null, fileIds: [], hasPoll: false, replyId: null, renoteId: null, threadId: null, channelId: null, visibility: 'public', visibleUserIds: [], mentions: [], replyUserId: null, localOnly: true };

function input(patch: Partial<RelatedNote> = {}): NotePostSaveInput {
	return { noteId: 'new-note', userId: 'author', renotedNoteId: target.id, repliedNoteId: null, channelId: null, pollExpiresAtMs: null, createdSnapshot: { note: { id: 'new-note', visibility: 'home', localOnly: true } as NewNote, reply: null, renote: { ...target, ...patch } } };
}

// This double records the platform boundary; expected commands come from the independent source oracle.
function recorder(result: [Error | null, unknown][] | null = [[null, '5'], [null, 1]]) {
	const commands: unknown[][] = [];
	const redis = {
		multi() {
			commands.push(['multi']);
			return {
				zincrby(...args: unknown[]) {
					commands.push(['zincrby', ...args]);
					return this;
				}, expire(...args: unknown[]) {
					commands.push(['expire', ...args]);
					return this;
				}, async exec() {
					commands.push(['exec']);
					return result;
				}
			};
		}
	} as unknown as Redis;
	return { redis, commands };
}

interface OracleRow {
	id: string;
	input: { mode?: string; nowMs: number; random: number; author: { id: string; isBot: boolean }; target: (Pick<RelatedNote, 'id' | 'userId' | 'userHost' | 'visibility' | 'channelId' | 'replyId'> & Partial<RelatedNote>) | null; note: Partial<NewNote>; rangeDays?: number };
	state: { scores: Record<string, number>; ttl: Record<string, { seconds: number }> };
}

const oracle: { observations: OracleRow[] } = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/note/featured/source-observations.json', import.meta.url), 'utf8'));
for (const row of oracle.observations.filter(row => row.input.mode === 'ok')) {
	test(`fixed source target/key/TTL: ${row.id}`, async () => {
		const value = input(row.input.target ?? {});
		const renote = row.input.target;
		value.renotedNoteId = renote && renote.userId !== row.input.author.id && !row.input.author.isBot ? renote.id : null;
		value.createdSnapshot!.renote = renote ? { ...target, ...renote } : null;
		Object.assign(value.createdSnapshot!.note, row.input.note);
		const { redis, commands } = recorder();
		const ranking = createFeaturedRanking(redis, () => row.input.nowMs);
		await createPostingFeatured({ add: ranking.add, currentTime: () => row.input.nowMs, random: () => row.input.random, createdAtFromId: Number })(value);
		const expected: unknown[][] = [];
		for (const [element, score] of Object.entries(row.state.scores)) {
			const [key, noteId] = element.split('/');
			expected.push(['multi'], ['zincrby', key, score, noteId], ['expire', key, row.state.ttl[key].seconds, 'NX'], ['exec']);
		}
		expect(commands).toEqual(expected);
	});
}

for (const row of oracle.observations.filter(row => row.id.startsWith('ranking-window-'))) {
	test(`fixed source writer window: ${row.id}`, async () => {
		const { redis, commands } = recorder();
		await createFeaturedRanking(redis, () => row.input.nowMs).add(row.input.rangeDays === 3 ? { kind: 'global', noteId: 'note' } : { kind: 'user', noteId: 'note', userId: 'user' });
		const [element, score] = Object.entries(row.state.scores)[0];
		const [key, noteId] = element.split('/');
		expect(commands).toEqual([['multi'], ['zincrby', key, score, noteId], ['expire', key, row.state.ttl[key].seconds, 'NX'], ['exec']]);
	});
}

test.each([0, 0.299999, 0.3, 1])('pure planner strictly samples %s and preserves future ID', sample => {
	expect(planRenoteFeatured(input(), { sample, now: 1000, createdAtMs: 1001 })).toEqual(sample < 0.3 ? [{ kind: 'global', noteId: target.id }, { kind: 'user', noteId: target.id, userId: target.userId }] : []);
});

test('ineligible outer gate never samples; rejected sample never reads age clock or ID', async () => {
	const calls: string[] = [];
	const run = createPostingFeatured({
		add: async () => {
			calls.push('add');
		}, currentTime: () => {
			calls.push('clock');
			return 0;
		}, random: () => {
			calls.push('random');
			return 0.3;
		}, createdAtFromId: () => {
			calls.push('id');
			return 0;
		}
	});
	await run({ ...input(), renotedNoteId: null });
	expect(calls).toEqual([]);
	await run(input());
	expect(calls).toEqual(['random']);
});

test('eligible missing snapshot is diagnosed rather than silently reread or reselected', async () => {
	await expect(createPostingFeatured({ add: async () => {}, currentTime: () => 0, random: () => 0, createdAtFromId: Number })({ ...input(), createdSnapshot: undefined })).rejects.toMatchObject({ code: 'NOTE_FEATURED_SNAPSHOT_MISSING' });
});

test('age clock and each ranking clock are independent across different window boundaries', async () => {
	const times = [1698451199999, 1698451200000, 1733011200000];
	const { redis, commands } = recorder();
	const clock = () => times.shift()!;
	await createPostingFeatured({ add: createFeaturedRanking(redis, clock).add, currentTime: clock, random: () => 0, createdAtFromId: () => 1698451199998 })(input());
	expect(commands).toEqual([
		['multi'], ['zincrby', 'featuredGlobalNotesRanking:100', 5, target.id], ['expire', 'featuredGlobalNotesRanking:100', 777600, 'NX'], ['exec'],
		['multi'], ['zincrby', 'featuredPerUserNotesRanking:target-author:100', 5, target.id], ['expire', 'featuredPerUserNotesRanking:target-author:100', 1814400, 'NX'], ['exec'],
	]);
	expect(times).toEqual([]);
});

test.each(['sync', 'async'])('global %s failure still starts and waits for per-user', async mode => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const started: FeaturedNoteScore[] = [];
	let settled = false;
	const run = createPostingFeatured({
		add: score => {
			started.push(score);
			if (score.kind === 'global') {
				if (mode === 'sync') {
					throw new Error('global');
				}
				return Promise.reject(new Error('global'));
			}
			return gate;
		}, currentTime: () => 1794054896000, random: () => 0, createdAtFromId: Number
	})(input());
	const assertion = expect(run).rejects.toMatchObject({ code: 'NOTE_FEATURED_FAILED', details: { failures: [expect.objectContaining({ kind: 'global', error: expect.any(Error) })] } }).then(() => {
		settled = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(started.map(score => score.kind)).toEqual(['global', 'user']);
	expect(settled).toBe(false);
	release();
	await assertion;
});

test.each([[[new Error('wrongtype'), null], [null, 1]], [[null, '5'], [new Error('expire'), null]], null])('writer reports command errors and aborted EXEC: %j', async result => {
	const { redis } = recorder(result as [Error | null, unknown][] | null);
	await expect(createFeaturedRanking(redis, () => 1794054896000).add({ kind: 'global', noteId: 'note' })).rejects.toMatchObject({ code: 'NOTE_FEATURED_REDIS_FAILED' });
});
