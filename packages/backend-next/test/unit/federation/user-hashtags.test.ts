/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { planUserHashtags } from '../../../src/modules/federation/user-hashtags.js';
import { createUserHashtags } from '../../../src/composition/user-hashtags.js';
import { createLogger } from '../../../src/platform/logger.js';
import type { UserHashtagChange } from '../../../src/modules/federation/user-hashtags.js';
const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/note/hashtag/source-observations.json', import.meta.url), 'utf8'));
const profiles: {
	id: string;
	input: {
		user: {
			id: string;
			host: string | null;
			tags: string[];
		};
		tags: string[];
	};
	calls: {
		method: string;
		sql: string;
		params: string[];
	}[];
}[] = source.observations.filter((c: {
	kind: string;
}) => c.kind === 'profile');
const settings = { hiddenTags: [], sensitiveWords: [] };
const user = { id: 'u1', host: 'remote.test', tags: ['old'] };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
}

test.each(profiles)('$id preserves the five pinned HashtagService profile operation sequences', fixture => {
	const expected = fixture.calls.filter((c: {
		method: string;
	}) => c.method === 'query').map((c: {
		sql: string;
		params: string[];
	}) => ({ tag: c.params[0], userId: c.params[1], userHost: fixture.input.user.host, attached: c.sql.startsWith('INSERT') }));
	expect(planUserHashtags(fixture.input.user, fixture.input.tags)).toEqual(expected);
});
test('start enters the first DB write immediately and copies both arrays before returning', async () => {
	const held = gate();
	const changes: UserHashtagChange[] = [];
	const old = { ...user, tags: ['old'] };
	const tags = ['Ａ', 'a'];
	const work = createUserHashtags({ change: async (value) => {
			changes.push(value);
			await held.promise;
		}, ranking: { update: async () => { } }, readSettings: async () => settings }, createLogger('test', () => { }));
	work.start(old, tags);
	expect(changes).toEqual([{ tag: 'a', userId: 'u1', userHost: 'remote.test', attached: true }]);
	old.tags[0] = 'mutated';
	tags[1] = 'mutated';
	held.release();
	await work.idle();
	expect(changes.map(v => [v.tag, v.attached])).toEqual([['a', true], ['a', true], ['old', false]]);
});
test.each(['hold', 'reject', 'throw'])('settings %s cannot gate ordered DB operations or leak a rejection', async (mode) => {
	const held = gate();
	const changes: string[] = [];
	const logs: string[] = [];
	const work = createUserHashtags({ change: async (value) => {
			changes.push(value.tag);
		}, ranking: { update: async () => { } }, readSettings: () => {
			if (mode === 'throw') {
				throw Error('settings');
			}
			if (mode === 'reject') {
				return Promise.reject(Error('settings'));
			}
			return held.promise.then(() => settings);
		} }, createLogger('test', line => logs.push(line)));
	work.start(user, ['a', 'b']);
	let closed = false;
	const closing = work.close().then(() => {
		closed = true;
	});
	await turn();
	expect(changes).toEqual(['a', 'b', 'old']);
	if (mode === 'hold') {
		expect(closed).toBe(false);
		held.release();
	}
	await closing;
	expect(logs.length).toBe(mode === 'hold' ? 0 : 1);
	if (mode !== 'hold') {
		expect(logs[0]).toContain('user-hashtags.failed');
		expect(logs[0]).toContain('u1');
	}
});
test.each(['hold', 'reject', 'throw'])('ranking %s cannot stop DB progress including removals', async (mode) => {
	const held = gate();
	const changes: string[] = [];
	const ranked: string[] = [];
	const logs: string[] = [];
	const work = createUserHashtags({ change: async (value) => {
			changes.push(value.tag);
		}, ranking: { update: value => {
				ranked.push(value.tag);
				if (mode === 'throw') {
					throw Error('redis');
				}
				return mode === 'reject' ? Promise.reject(Error('redis')) : held.promise;
			} }, readSettings: async () => settings }, createLogger('test', line => logs.push(line)));
	work.start(user, ['a', 'b']);
	await turn();
	expect(changes).toEqual(['a', 'b', 'old']);
	expect(ranked).toEqual(['a', 'b', 'old']);
	let idle = false;
	const draining = work.idle().then(() => {
		idle = true;
	});
	if (mode === 'hold') {
		await turn();
		expect(idle).toBe(false);
		held.release();
	}
	await draining;
	expect(logs.length).toBe(mode === 'hold' ? 0 : 1);
});
test('DB failure stops later tags but keeps its already launched ranking alive through close', async () => {
	const held = gate();
	const changes: string[] = [];
	const ranked: string[] = [];
	const logs: string[] = [];
	const work = createUserHashtags({ change: async (value) => {
			changes.push(value.tag);
			throw Error('database');
		}, ranking: { update: async (value) => {
				ranked.push(value.tag);
				await held.promise;
			} }, readSettings: async () => settings }, createLogger('test', line => logs.push(line)));
	work.start(user, ['a', 'b']);
	await turn();
	expect(changes).toEqual(['a']);
	expect(ranked).toEqual(['a']);
	let closed = false;
	const closing = work.close().then(() => {
		closed = true;
	});
	await turn();
	expect(closed).toBe(false);
	held.release();
	await closing;
	expect(logs).toHaveLength(1);
	expect(logs[0]).toContain('attachment');
	expect(logs[0]).toContain('a');
});
test('drain also waits for a second actor started while the first write is pending', async () => {
	const first = gate();
	const second = gate();
	const work = createUserHashtags({ change: value => value.userId === 'u1' ? first.promise : second.promise, ranking: { update: async () => { } }, readSettings: async () => settings }, createLogger('test', () => { }));
	work.start({ ...user, tags: [] }, ['a']);
	let closed = false;
	const closing = work.close().then(() => {
		closed = true;
	});
	work.start({ ...user, id: 'u2', tags: [] }, ['b']);
	first.release();
	await turn();
	expect(closed).toBe(false);
	second.release();
	await closing;
	expect(closed).toBe(true);
});
