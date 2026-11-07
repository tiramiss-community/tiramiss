/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { checkHitAntenna, type AntennaDefinition, type AntennaNote } from '../../../src/modules/note/antenna-plan.js';
import { createPostingAntennas } from '../../../src/composition/posting-antennas.js';
import { createNoteAntennaCache } from '../../../src/platform/note-antennas.js';
import { createTimelineCache } from '../../../src/platform/timeline-cache.js';
import { createHostRules } from '../../../src/modules/federation/public.js';
import type { NotePostSaveInput } from '../../../src/modules/note/public.js';
const antenna = (extra: Partial<AntennaDefinition> = {}): AntennaDefinition => ({
	id: 'a', userId: 'owner', src: 'all', userListId: null, users: [], keywords: [], excludeKeywords: [], caseSensitive: false, excludeBots: false, withReplies: true, withFile: false, isActive: true, localOnly: false, excludeNotesInSensitiveChannel: false, ...extra
});
const note = (extra: Partial<AntennaNote> = {}): AntennaNote => ({
	id: 'note', userId: 'author', visibility: 'public', visibleUserIds: [], text: 'hello', cw: null, replyId: null, fileIds: [], channel: null, ...extra
});
const author = {
	id: 'author', username: 'Alice', host: null, isBot: false
};
const ports = () => ({ followingIds: vi.fn(async () => new Set<string>()), listContains: vi.fn(async () => true), fullApAccount: createHostRules('local.test:3000').fullApAccount });
const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test.each([
	['all', {}, true], ['home TODO', { src: 'home' }, true], ['sensitive', { excludeNotesInSensitiveChannel: true }, false], ['bot', { excludeBots: true }, false], ['remote', { localOnly: true }, false], ['reply', { withReplies: false }, false],
] as const)('ordered early %s gate avoids dynamic reads', async (_name, extra, expected) => {
	const p = ports();
	expect(await checkHitAntenna(antenna(extra), note({ channel: { isSensitive: true }, replyId: 'r' }), { ...author, host: 'remote.test', isBot: true }, p)).toBe(expected);
	expect(p.followingIds).not.toHaveBeenCalled();
	expect(p.listContains).not.toHaveBeenCalled();
});
test('followers self still obtains followings and its failure rejects before a list lookup', async () => {
	const p = ports();
	p.followingIds.mockRejectedValue(new Error('cache'));
	await expect(checkHitAntenna(antenna({ userId: author.id, src: 'list', userListId: 'l' }), note({ visibility: 'followers' }), author, p)).rejects.toThrow('cache');
	expect(p.listContains).not.toHaveBeenCalled();
});
test.each(['public', 'home', 'followers', 'specified'] as const)('visibility %s uses only the conditional following lookup', async (visibility) => {
	const p = ports();
	expect(await checkHitAntenna(antenna(), note({ visibility }), author, p)).toBe(visibility === 'public' || visibility === 'home');
	expect(p.followingIds).toHaveBeenCalledTimes(visibility === 'followers' ? 1 : 0);
	expect(await checkHitAntenna(antenna({ userId: author.id }), note({ visibility }), author, ports())).toBe(true);
	expect(await checkHitAntenna(antenna(), note({ visibility, visibleUserIds: ['owner'] }), author, ports())).toBe(visibility !== 'followers');
});
test('following presence and fresh list membership are independent of withReplies', async () => {
	const p = ports();
	p.followingIds.mockResolvedValue(new Set(['author']));
	expect(await checkHitAntenna(antenna({ src: 'list', userListId: 'l' }), note({ visibility: 'followers' }), author, p)).toBe(true);
	p.listContains.mockResolvedValue(false);
	expect(await checkHitAntenna(antenna({ src: 'list', userListId: 'l' }), note(), author, p)).toBe(false);
	expect(await checkHitAntenna(antenna({ src: 'list' }), note(), author, p)).toBe(false);
});
test.each(['Alice', '@ALICE', 'alice@local.test:3000', '@alice@LOCAL.TEST:3000'])('users source account %s follows source parse', async (account) => {
	expect(await checkHitAntenna(antenna({ src: 'users', users: [account] }), note(), author, ports())).toBe(true);
	expect(await checkHitAntenna(antenna({ src: 'users_blacklist', users: [account] }), note(), author, ports())).toBe(false);
});
test('account IDNA and split-at-two preserve malformed and whitespace behavior', async () => {
	const p = ports();
	expect(await checkHitAntenna(antenna({ src: 'users', users: ['@ÄLICE@例え.テスト@ignored'] }), note(), { ...author, username: 'älice', host: 'xn--r8jz45g.xn--zckzah' }, p)).toBe(true);
	expect(await checkHitAntenna(antenna({ src: 'users', users: [' Alice'] }), note(), author, p)).toBe(false);
});
test.each([
	[{ keywords: [['', '']] }, null, null, true], [{ keywords: [[' ']] }, null, null, false], [{ keywords: [['hello', 'CW'], ['other']] }, 'hello', 'CW', true],
	[{ keywords: [['hello\nCW']] }, 'hello', 'CW', true], [{ keywords: [['HELLO']], caseSensitive: true }, 'hello', null, false],
	[{ excludeKeywords: [['bad']] }, null, null, false], [{ excludeKeywords: [['']] }, null, null, true], [{ excludeKeywords: [['hello', 'cw']] }, 'HELLO', 'CW', false],
	[{ keywords: [['.*']] }, 'hello', null, false],
] as const)('literal keyword matrix %j %s %s', async (extra, text, cw, hit) => {
	expect(await checkHitAntenna(antenna(JSON.parse(JSON.stringify(extra))), note({ text, cw }), author, ports())).toBe(hit);
});
test('withFile rejects only a present empty file array; pure renote target and expression are ignored', async () => {
	expect(await checkHitAntenna(antenna({ withFile: true }), note(), author, ports())).toBe(false);
	expect(await checkHitAntenna(antenna({ withFile: true }), note({ fileIds: undefined }), author, ports())).toBe(true);
	expect(await checkHitAntenna(antenna({ withFile: true }), note({ fileIds: ['f'] }), author, ports())).toBe(true);
	expect(await checkHitAntenna(antenna({ keywords: [['target']] }), note({ text: null }), author, ports())).toBe(false);
});

function producer(definitions: AntennaDefinition[], extra: Partial<Parameters<typeof createPostingAntennas>[0]> = {}) {
	const calls: unknown[] = [];
	const cache = createTimelineCache({ pipeline: () => ({
			lpush: (...args: unknown[]) => calls.push(['push', ...args]), ltrim: (...args: unknown[]) => calls.push(['trim', ...args]), exec: async () => {
				calls.push(['exec']);
				return [];
			}
		}), lindex: async () => null, lpush: async () => 1 }, { createdAtFromId: () => 1, currentTime: () => 1, random: () => 1 });
	const run = createPostingAntennas({
		definitions: async () => definitions, ...ports(), cache, publish: async (id, body) => {
			calls.push(['publish', id, body]);
		}, ...extra
	});
	const input = {
		noteId: 'note', userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null, createdSnapshot: {
			note: note(), author, channel: null, reply: null, renote: null, rawNote: {
				id: 'note', mentionedRemoteUsers: '[]', reply: null, renote: null
			}
		}
	} as unknown as NotePostSaveInput;
	return { calls, run: () => run(input) };
}

test('all matchers start together; one rejection suppresses every effect and drains held siblings', async () => {
	const held = deferred<boolean>();
	const reads: string[] = [];
	const p = producer([antenna(), antenna({ id: 'broken', src: 'list', userListId: 'broken' }), antenna({ id: 'held', src: 'list', userListId: 'held' })], {
		listContains: async (id) => {
			reads.push(id);
			if (id === 'broken') {
				throw new Error('lookup');
			}
			return held.promise;
		}
	});
	let done = false;
	const result = p.run().catch(error => {
		done = true;
		return error;
	});
	await tick();
	expect(reads).toEqual(['broken', 'held']);
	expect(p.calls).toEqual([]);
	expect(done).toBe(false);
	held.resolve(true);
	expect(await result).toBeInstanceOf(Error);
	expect(p.calls).toEqual([]);
});
test.each(['reject', 'held'] as const)('publication %s keeps later output and flush independent, and is drained', async (mode) => {
	const held = deferred();
	const published: string[] = [];
	const p = producer([antenna(), antenna({ id: 'b' })], {
		publish: id => {
			published.push(id);
			return mode === 'held' ? held.promise : Promise.reject(new Error('publish'));
		}
	});
	let done = false;
	const result = p.run().catch(error => error).then(value => {
		done = true;
		return value;
	});
	await tick();
	expect(published).toEqual(['a', 'b']);
	expect(p.calls).toContainEqual(['exec']);
	expect(done).toBe(mode === 'reject');
	held.resolve();
	await result;
});
test('synchronous publication preparation throw stops unsent pipeline, but drains already started old-ID work', async () => {
	const held = deferred<string | null>();
	const calls: string[] = [];
	const cache = createTimelineCache({
		pipeline: () => ({
			lpush: () => { }, ltrim: () => { }, exec: async () => {
				calls.push('exec');
				return [];
			}
		}), lindex: () => {
			calls.push('old');
			return held.promise;
		}, lpush: async () => {
			calls.push('direct');
			return 1;
		}
	}, { createdAtFromId: () => 0, currentTime: () => 180000, random: () => 1 });
	const p = producer([antenna(), antenna({ id: 'b' })], {
		cache, publish: () => {
			calls.push('publish');
			throw new Error('sync');
		}
	});
	let done = false;
	const result = p.run().catch(error => {
		done = true;
		return error;
	});
	await tick();
	expect(calls).toEqual(['old', 'publish']);
	expect(done).toBe(false);
	held.resolve(null);
	await result;
	expect(calls).toEqual(['old', 'publish', 'direct']);
});
test('no matches still executes the empty pipeline and raw body is published with creation channel', async () => {
	const p = producer([antenna({ keywords: [['missing']] })]);
	await p.run();
	expect(p.calls).toEqual([['exec']]);
	const q = producer([antenna()]);
	await q.run();
	expect(q.calls[1]).toEqual(['publish', 'a', {
			id: 'note', mentionedRemoteUsers: '[]', reply: null, renote: null, channel: null
		}]);
});

function cacheWorld() {
	let now = 0;
	let active = [antenna()];
	const storage = new Map<string, string>();
	const writes: unknown[] = [];
	const errors: unknown[] = [];
	const reader = { active: vi.fn(async () => active), followings: vi.fn(async () => [{ followeeId: 'author', withReplies: true }]) };
	const redis = { get: vi.fn(async (key: string) => storage.get(key) ?? null), set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
			writes.push([key, value, ...args]);
			storage.set(key, value);
			return 'OK';
		}), del: vi.fn(async (key: string) => {
			storage.delete(key);
			return 1;
		}) };
	const cache = createNoteAntennaCache({
		reader, redis, currentTime: () => now, onError: (error: unknown) => {
			errors.push(error);
		}
	});
	const event = (type: string, body: unknown) => cache.onMessage(JSON.stringify({ channel: 'internal', message: { type, body } }));
	return {
		cache, event, reader, redis, storage, writes, errors, time: (value: number) => {
			now = value;
		}, active: (value: AntennaDefinition[]) => {
			active = value;
		}
	};
}

test('lazy active bootstrap, resident database changes, inactive updates/upserts and duplicate deletes follow source', async () => {
	const w = cacheWorld();
	expect(w.reader.active).not.toHaveBeenCalled();
	await w.cache.definitions();
	w.active([]);
	expect(await w.cache.definitions()).toHaveLength(1);
	expect(w.reader.active).toHaveBeenCalledTimes(1);
	w.event('antennaCreated', antenna({ isActive: false }));
	w.event('antennaUpdated', antenna({ isActive: false, users: ['new'] }));
	expect(await w.cache.definitions()).toEqual([antenna({ isActive: false, users: ['new'] }), antenna({ isActive: false })]);
	w.event('antennaUpdated', antenna({ id: 'new', isActive: false }));
	expect(await w.cache.definitions()).toHaveLength(3);
	w.event('antennaDeleted', { id: 'a' });
	expect(await w.cache.definitions()).toEqual([antenna({ id: 'new', isActive: false })]);
});
test('source initial-load event overwrite and concurrent cold completion order remain visible; failed fetch retries', async () => {
	const w = cacheWorld();
	const first = deferred<AntennaDefinition[]>(), second = deferred<AntennaDefinition[]>();
	w.reader.active.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
	const a = w.cache.definitions(), b = w.cache.definitions();
	w.event('antennaCreated', antenna({ id: 'event' }));
	second.resolve([antenna({ id: 'second' })]);
	await b;
	first.resolve([antenna({ id: 'first' })]);
	await a;
	expect(await w.cache.definitions()).toEqual([antenna({ id: 'first' })]);
	expect(w.reader.active).toHaveBeenCalledTimes(2);
	const x = cacheWorld();
	x.reader.active.mockRejectedValueOnce(new Error('read'));
	await expect(x.cache.definitions()).rejects.toThrow('read');
	expect(await x.cache.definitions()).toHaveLength(1);
});
test('following Redis 30m and memory exact 60s boundary, follow invalidation and ignored unfollow', async () => {
	const w = cacheWorld();
	expect(await w.cache.followingIds('owner')).toEqual(new Set(['author']));
	expect(w.writes).toEqual([['kvcache:userFollowings:owner', '{"author":{"withReplies":true}}', 'EX', 1800]]);
	w.storage.set('kvcache:userFollowings:owner', '{"new":{"withReplies":false}}');
	w.time(60000);
	expect(await w.cache.followingIds('owner')).toEqual(new Set(['author']));
	w.time(60001);
	expect(await w.cache.followingIds('owner')).toEqual(new Set(['new']));
	expect(w.reader.followings).toHaveBeenCalledTimes(1);
	w.event('unfollow', { followerId: 'owner' });
	expect(w.redis.del).not.toHaveBeenCalled();
	w.event('follow', { followerId: 'owner' });
	await w.cache.close();
	expect(w.redis.del).toHaveBeenCalledWith('kvcache:userFollowings:owner');
	expect(await w.cache.followingIds('owner')).toEqual(new Set(['author']));
});
test('cache GET/SET rejection propagates without fallback; memory is filled before SET failure', async () => {
	const w = cacheWorld();
	w.redis.get.mockRejectedValueOnce(new Error('get'));
	await expect(w.cache.followingIds('owner')).rejects.toThrow('get');
	expect(w.reader.followings).not.toHaveBeenCalled();
	w.redis.set.mockRejectedValueOnce(new Error('set'));
	await expect(w.cache.followingIds('owner')).rejects.toThrow('set');
	expect(await w.cache.followingIds('owner')).toEqual(new Set(['author']));
});
test('follow DEL starts immediately, close drains held deletion, failures diagnosed', async () => {
	const w = cacheWorld();
	const held = deferred<number>();
	w.redis.del.mockReturnValueOnce(held.promise);
	w.event('follow', { followerId: 'owner' });
	let closed = false;
	const closing = w.cache.close().then(() => {
		closed = true;
	});
	await tick();
	expect(closed).toBe(false);
	held.reject(new Error('del'));
	await closing;
	expect(w.errors).toHaveLength(1);
});
interface SourceRow {
	id: string;
	input: {
		antenna: AntennaDefinition;
		note: AntennaNote;
		noteUser: typeof author;
		followingIds: string[];
		listMember: boolean;
		tail: number | null;
		now: number;
		random: number;
	};
	hit: boolean;
	calls: Record<string, unknown>[];
}
const corpus = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/note/antenna/source-observations.json', import.meta.url), 'utf8')) as {
	observations: SourceRow[];
};
const sourceMatches = corpus.observations.filter(row => row.id.startsWith('match-'));
test.each(sourceMatches)('fixed-source direct predicate and conditional lookup trace: $id', async (row) => {
	const calls: Record<string, unknown>[] = [];
	const hit = await checkHitAntenna(row.input.antenna, row.input.note, row.input.noteUser, {
		fullApAccount: createHostRules('local.example').fullApAccount,
		followingIds: async (userId) => {
			calls.push({ method: 'readFollowings', userId });
			return new Set(row.input.followingIds);
		},
		listContains: async (userListId, userId) => {
			calls.push({ method: 'readList', query: { where: { userListId, userId } } });
			return row.input.listMember;
		},
	});
	expect(hit).toBe(row.hit);
	expect(calls).toEqual(row.calls);
});
const sourceUpdates = corpus.observations.filter(row => row.id.startsWith('producer-age'));
test.each(sourceUpdates)('fixed-source direct timeline writes and publication start order: $id', async (row) => {
	const calls: Record<string, unknown>[] = [];
	const cache = createTimelineCache({
		pipeline: () => {
			calls.push({ method: 'pipeline' });
			return {
				lpush: (key, id) => {
					calls.push({ method: 'pipeline.lpush', key, id });
				},
				ltrim: (key, start, end) => {
					calls.push({
						method: 'pipeline.ltrim', key, start, end
					});
				},
				exec: async () => {
					calls.push({ method: 'pipeline.exec' });
					return [];
				},
			};
		},
		lindex: async (key, index) => {
			calls.push({ method: 'lindex', key, index });
			return row.input.tail === null ? null : String(row.input.tail);
		},
		lpush: async (key, id) => {
			calls.push({ method: 'direct.lpush', key, id });
			return 1;
		},
	}, { createdAtFromId: Number, currentTime: () => row.input.now, random: () => row.input.random });
	const input = {
		noteId: row.input.note.id, userId: row.input.note.userId, repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null, createdSnapshot: {
			note: row.input.note, author: row.input.noteUser, channel: null, reply: null, renote: null, rawNote: row.input.note
		}
	} as unknown as NotePostSaveInput;
	const run = createPostingAntennas({
		definitions: async () => {
			calls.push({ method: 'readAntennas', query: { isActive: true } });
			return [row.input.antenna];
		}, ...ports(), cache, publish: async (id) => {
			calls.push({ method: 'antennaPublication', antennaId: id, type: 'note' });
		}
	});
	await run(input);
	expect(calls).toEqual(row.calls.map(({ note: _note, ...call }) => call));
});
