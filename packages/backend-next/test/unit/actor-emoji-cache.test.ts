/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createActorEmojiCache } from '../../src/platform/actor-emoji-cache.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';

const remote = (cache: ReturnType<typeof createActorEmojiCache>, emojis: readonly string[], host: string | null, selfHost: string) => cache.remote([{ emojis, host }], selfHost);

const row = { name: 'wave', host: null, type: null, publicUrl: 'https://old.test/wave', originalUrl: 'https://original.test/wave', updatedAt: new Date(1000), license: null, localOnly: false };

function setup() {
	let time = 0, unavailable = false, rows = [{ ...row }];
	const redisValues = new Map<string, string>();
	const redis = { async get(key: string) {
		return redisValues.get(key) ?? null;
	}, async set(key: string, value: string, mode: string, seconds: number) {
		expect([mode, seconds]).toEqual(['EX', 1800]); redisValues.set(key, value); return 'OK';
	} } as unknown as Redis;
	const manager = { getRepository: () => ({ async findBy() {
		if (unavailable) {
			throw Error('database stopped');
		} return rows.map(r => ({ ...r }));
	}, async findOneBy({ name, host }: { name: string; host: string }) {
		if (unavailable) {
			throw Error('database stopped');
		} return rows.find(r => r.name === name && r.host === host) ?? null;
	} }) } as unknown as EntityManager;
	const cache = createActorEmojiCache(manager, redis, () => time);
	return { cache, redisValues, setTime: (value: number) => {
		time = value;
	}, stop: () => {
		unavailable = true;
	}, rows: (value: typeof rows) => {
		rows = value;
	} };
}

test('local memory lasts through the exact three minute boundary and Redis revives dates after it', async () => {
	const h = setup();
	try {
		expect(await h.cache.local(['wave', 'wave'])).toMatchObject([{ updatedAtMs: 1000 }, { updatedAtMs: 1000 }]);
		expect(JSON.parse(h.redisValues.get('singlecache:localEmojis')!)[0].updatedAt).toBe('1970-01-01T00:00:01.000Z');
		h.stop(); h.setTime(180000);
		expect(await h.cache.local(['wave'])).toMatchObject([{ publicUrl: row.publicUrl }]);
		h.setTime(180001);
		expect(await h.cache.local(['wave'])).toMatchObject([{ updatedAtMs: 1000 }]);
		h.redisValues.clear(); h.setTime(360002);
		await expect(h.cache.local(['wave'])).rejects.toThrow('database stopped');
	} finally {
		await h.cache.close();
	}
});

test('remote positive and negative results stay stale for twelve hours without import invalidation', async () => {
	const h = setup(); h.rows([{ ...row, host: 'remote.test' as never }]);
	try {
		expect(await remote(h.cache, ['wave', 'missing'], 'remote.test', 'local.test')).toEqual(new Map([['wave@remote.test', row.publicUrl]]));
		h.rows([{ ...row, host: 'remote.test' as never, publicUrl: 'https://new.test/wave' }, { ...row, name: 'missing', host: 'remote.test' as never }]);
		h.setTime(43200000);
		expect(await remote(h.cache, ['wave', 'missing'], 'remote.test', 'local.test')).toEqual(new Map([['wave@remote.test', row.publicUrl]]));
		h.setTime(43200001);
		expect(await remote(h.cache, ['wave', 'missing'], 'remote.test', 'local.test')).toEqual(new Map([['wave@remote.test', 'https://new.test/wave'], ['missing@remote.test', row.publicUrl]]));
	} finally {
		await h.cache.close();
	}
});

test('remote source GC expires entries at the exact boundary and close stops its timer', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const h = setup(); h.rows([{ ...row, host: 'remote.test' as never }]);
	try {
		await remote(h.cache, ['wave'], 'remote.test', 'local.test'); h.rows([]); h.setTime(43200000);
		await vi.advanceTimersByTimeAsync(180000);
		expect(await remote(h.cache, ['wave'], 'remote.test', 'local.test')).toEqual(new Map());
		await h.cache.close(); expect(vi.getTimerCount()).toBe(0);
		await expect(h.cache.local(['wave'])).rejects.toThrow('closed');
	} finally {
		await h.cache.close(); vi.useRealTimers();
	}
});

test('closing drains a pending lookup and rejects new reads', async () => {
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const entered = new Promise<void>(resolve => {
		started = resolve;
	});
	const manager = { getRepository: () => ({ async findBy() {
		started(); await gate; return [row];
	} }) } as unknown as EntityManager;
	const redis = { get: async () => null, set: async () => 'OK' } as unknown as Redis;
	const cache = createActorEmojiCache(manager, redis, () => 0);
	const reading = cache.local(['wave']); await entered;
	let closed = false; const closing = cache.close().then(() => {
		closed = true;
	});
	await Promise.resolve(); expect(closed).toBe(false);
	await expect(remote(cache, ['wave'], 'remote.test', 'local.test')).rejects.toThrow('closed');
	release(); expect(await reading).toMatchObject([{ name: 'wave' }]); await closing; expect(closed).toBe(true);
});

test('local memory remains populated when the awaited Redis write fails, as source does', async () => {
	let unavailable = false;
	const manager = { getRepository: () => ({ async findBy() {
		if (unavailable) {
			throw Error('database stopped');
		} return [row];
	} }) } as unknown as EntityManager;
	const cache = createActorEmojiCache(manager, { get: async () => null, set: async () => {
		throw Error('redis write failed');
	} } as unknown as Redis, () => 0);
	try {
		await expect(cache.local(['wave'])).rejects.toThrow('redis write failed'); unavailable = true;
		expect(await cache.local(['wave'])).toMatchObject([{ name: 'wave' }]);
	} finally {
		await cache.close();
	}
});

test('source observations pin remote positive, null, fallback and exact expiry results', async () => {
	const { default: source } = await import('../../../../docs/superpowers/compatibility/actor-emoji-cache/observations.json', { with: { type: 'json' } });
	const h = setup(); h.rows([{ ...row, host: 'remote.test' as never }]);
	const names = ['wave', 'missing', 'wave@.', 'invalid:name'];
	const observe = async (id: string) => {
		const urls = await remote(h.cache, names, 'remote.test', 'local.test');
		expect([urls.get('wave@remote.test') ?? null, urls.get('missing@remote.test') ?? null, null, null]).toEqual(source.observations.find(o => o.id === id)!.values);
	};
	try {
		await observe('remote-cold-positive-negative');
		h.setTime(43200000); await observe('remote-exact-boundary-still-stale');
		h.rows([{ ...row, host: 'remote.test' as never, publicUrl: 'https://new.test/wave' }, { ...row, host: 'remote.test' as never, name: 'missing', publicUrl: '', originalUrl: 'https://original.test/missing' }]);
		h.setTime(43200001); await observe('remote-expired-refresh');
	} finally {
		await h.cache.close();
	}
});

test('failed cold batch preserves warm hits and is retried without caching failure', async () => {
	let fail = false, calls = 0;
	const rows = [{ ...row, host: 'remote.test' }];
	const manager = { getRepository: () => ({ async findBy() {
		calls++; if (fail) {
			throw Error('batch unavailable');
		} return rows;
	} }) } as unknown as EntityManager;
	const cache = createActorEmojiCache(manager, {} as Redis, () => 0);
	try {
		expect(await remote(cache, ['wave'], 'remote.test', 'local.test')).toEqual(new Map([['wave@remote.test', row.publicUrl]]));
		fail = true;
		await expect(remote(cache, ['wave', 'missing'], 'remote.test', 'local.test')).rejects.toThrow('batch unavailable');
		expect(await remote(cache, ['wave'], 'remote.test', 'local.test')).toEqual(new Map([['wave@remote.test', row.publicUrl]]));
		expect(calls).toBe(2);
		fail = false; rows.length = 0;
		expect(await remote(cache, ['wave', 'missing'], 'remote.test', 'local.test')).toEqual(new Map([['wave@remote.test', row.publicUrl]]));
		expect(calls).toBe(3);
		fail = true;
		expect(await remote(cache, ['missing'], 'remote.test', 'local.test')).toEqual(new Map());
		expect(calls).toBe(3);
	} finally {
		await cache.close();
	}
});

test('close waits for the accepted remote batch and rejects later reads', async () => {
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const entered = new Promise<void>(resolve => {
		started = resolve;
	});
	const manager = { getRepository: () => ({ async findBy() {
		started(); await gate; return [{ ...row, host: 'remote.test' }];
	} }) } as unknown as EntityManager;
	const cache = createActorEmojiCache(manager, {} as Redis, () => 0);
	const reading = remote(cache, ['wave'], 'remote.test', 'local.test'); await entered;
	let closed = false; const closing = cache.close().then(() => {
		closed = true;
	});
	await Promise.resolve(); expect(closed).toBe(false);
	await expect(remote(cache, ['wave'], 'remote.test', 'local.test')).rejects.toThrow('closed');
	release(); expect(await reading).toEqual(new Map([['wave@remote.test', row.publicUrl]]));
	await closing; expect(closed).toBe(true);
});

test('one batch normalizes and deduplicates host/name pairs without fetching invalid or local names', async () => {
	const queries: { host: string; names: string[] }[][] = [];
	const manager = { getRepository: () => ({ async findBy(where: { host: string; name: { value: string[] } }[]) {
		queries.push(where.map(clause => ({ host: clause.host, names: clause.name.value })));
		return [{ ...row, host: 'remote.test' }, { ...row, host: 'other.test', publicUrl: 'https://other.test/wave' }];
	} }) } as unknown as EntityManager;
	const cache = createActorEmojiCache(manager, {} as Redis, () => 0);
	try {
		expect(await cache.remote([
			{ host: 'REMOTE.TEST', emojis: ['wave', 'wave', 'wave@.', 'bad name', 'wave@local.test'] },
			{ host: 'remote.test', emojis: ['wave', 'missing'] },
			{ host: 'other.test', emojis: ['wave'] },
			{ host: null, emojis: ['wave', 'wave@remote.test'] },
		], 'local.test')).toEqual(new Map([['wave@remote.test', row.publicUrl], ['wave@other.test', 'https://other.test/wave']]));
		expect(queries).toEqual([[{ host: 'remote.test', names: ['wave', 'missing'] }, { host: 'other.test', names: ['wave'] }]]);
		expect(await cache.remote([], 'local.test')).toEqual(new Map());
		expect(queries).toHaveLength(1);
	} finally {
		await cache.close();
	}
});
