/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createMetaCache } from '../../src/platform/meta-cache.js';
import type { InternalEvents } from '../../src/platform/internal-events.js';
import type { MiMeta } from 'backend-upstream/entities';
const fixture = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/meta-cache/observations.json', import.meta.url), 'utf8'));

function harness(periodic = false) {
	const handlers = new Set<Parameters<InternalEvents['register']>[0]>();
	let rows = [{ id: 'a', name: 'old' }, { id: 'z', name: 'new' }]; let reads = 0; let failure = false; let gate: Promise<void> | undefined;
	const onError = vi.fn();
	const cache = createMetaCache({ events: { register: handler => {
		handlers.add(handler); return () => {
			handlers.delete(handler);
		};
	} }, periodic, onError, read: async () => {
		reads++; const snapshot = structuredClone(rows).sort((a, b) => b.id.localeCompare(a.id));
		await gate;
		if (failure) {
			throw new Error('database unavailable');
		}
		if (!snapshot.length) {
			rows = [{ id: 'x' } as typeof rows[number]];
		}
		return (snapshot[0] ?? rows[0]) as MiMeta;
	} });
	return { cache, onError, reads: () => reads, rows: (next: typeof rows) => {
		rows = next;
	}, failure: (value: boolean) => {
		failure = value;
	}, gate: (value?: Promise<void>) => {
		gate = value;
	}, notify: async (after: unknown, type = 'metaUpdated') => {
		for (const handler of handlers) {
			await handler.onInternal?.({ type, body: { before: { name: 'before' }, after } });
		}
	}, handlers };
}

afterEach(() => vi.useRealTimers());
test('finite source fetch/hit/noCache/after/race/failure/periodic/empty projections match', async () => {
	vi.useFakeTimers(); const h = harness(true); const observations: unknown[] = [];
	const observe = async (id: string) => observations.push({ id, cache: await h.cache.fetch(), reads: h.reads() });
	await observe('newest-id'); h.rows([{ id: 'z', name: 'database' }]); await observe('cache-hit');
	await h.cache.fetch(true); await observe('no-cache');
	await h.notify({ id: 'z', name: 'event', rootUser: { id: 'joined' } }); await observe('notification-after');
	await h.notify({ name: 'ignored' }, 'other'); await observe('unrelated-event');
	let release!: () => void; h.gate(new Promise(resolve => {
		release = resolve;
	})); const pending = h.cache.fetch(true);
	await h.notify({ id: 'z', name: 'racing-event' }); release(); await pending; h.gate(); await observe('fetch-overwrites-notification');
	h.failure(true); await expect(h.cache.fetch(true)).rejects.toThrow('database unavailable'); h.failure(false); await observe('failed-read-retains-cache');
	h.rows([{ id: 'z', name: 'periodic' }]); await vi.advanceTimersByTimeAsync(300000); await observe('periodic-reload');
	await h.cache.close();
	const empty = harness(); empty.rows([]); observations.push({ id: 'empty-initialization', cache: await empty.cache.fetch(), reads: h.reads() + empty.reads() }); await empty.cache.close();
	expect(observations).toEqual(fixture.observations);
});
test('timer DB failure is reported, retains the value and permits a later reload', async () => {
	vi.useFakeTimers(); const h = harness(true); await h.cache.fetch(); h.failure(true);
	await vi.advanceTimersByTimeAsync(300000); expect(h.onError).toHaveBeenCalledOnce(); expect((await h.cache.fetch()).name).toBe('new');
	h.failure(false); h.rows([{ id: 'z', name: 'recovered' }]); await vi.advanceTimersByTimeAsync(300000); expect((await h.cache.fetch()).name).toBe('recovered'); await h.cache.close();
});
test('close cancels future work, unregisters and waits for an accepted fetch', async () => {
	vi.useFakeTimers(); const h = harness(true); let release!: () => void;
	h.gate(new Promise(resolve => {
		release = resolve;
	})); const pending = h.cache.fetch(); let done = false;
	const close = h.cache.close().then(() => {
		done = true;
	}); await Promise.resolve(); expect(done).toBe(false); expect(h.handlers.size).toBe(0);
	release(); await pending; await close; await vi.advanceTimersByTimeAsync(600000); expect(h.reads()).toBe(1);
	await expect(h.cache.fetch(true)).rejects.toThrow('Meta cache is closed'); await h.cache.close();
});

test('producer refresh uses its primary reader, updates the ordinary cache and drains on close', async () => {
	const h = harness(); await h.cache.fetch();
	let release!: (value: MiMeta) => void;
	const primary = vi.fn(() => new Promise<MiMeta>(resolve => {
		release = resolve;
	}));
	const pending = h.cache.refresh(primary);
	let closed = false;
	const closing = h.cache.close().then(() => {
		closed = true;
	});
	await Promise.resolve(); expect(closed).toBe(false);
	release({ id: 'z', name: 'primary' } as MiMeta); expect(await pending).toMatchObject({ name: 'primary' });
	await closing; expect(closed).toBe(true); expect(primary).toHaveBeenCalledOnce(); expect(h.reads()).toBe(1);
	const other = harness(); await other.cache.fetch();
	await other.cache.refresh(async () => ({ id: 'z', name: 'fresh' } as MiMeta));
	expect((await other.cache.fetch()).name).toBe('fresh'); expect(other.reads()).toBe(1);
	await expect(other.cache.refresh(async () => {
		throw new Error('failed primary');
	})).rejects.toThrow('failed primary');
	expect((await other.cache.fetch()).name).toBe('fresh'); await other.cache.close();
});
