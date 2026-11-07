/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createNoteInstanceCounts } from '../../../src/platform/note-instance-counts.js';
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>(yes => {
		resolve = yes;
	});
	return { promise, resolve };
};

function setup(extra: Partial<Parameters<typeof createNoteInstanceCounts>[0]> = {}) {
	const calls: unknown[] = [];
	const ports = {
		enabled: vi.fn(async () => true), fetchOrRegister: vi.fn(async (host: string) => ({ id: host, host })), increment: vi.fn(async (id: string, amount: number) => {
			calls.push(['increment', id, amount]);
		}), decrement: vi.fn(async (id: string) => {
			calls.push(['decrement', id, 1]);
		}), delayMs: 300000, onError: vi.fn(), ...extra
	};
	return { ports, calls, counts: createNoteInstanceCounts(ports) };
}

afterEach(() => {
	vi.useRealTimers();
});
test('only enabled remote notes register; local or disabled notes perform no writes', async () => {
	const w = setup();
	await w.counts.created(null);
	await w.counts.deleted(null);
	expect(w.ports.enabled).not.toHaveBeenCalled();
	vi.mocked(w.ports.enabled).mockResolvedValue(false);
	await w.counts.created('remote.test');
	await w.counts.deleted('remote.test');
	expect(w.ports.fetchOrRegister).not.toHaveBeenCalled();
	expect(w.calls).toEqual([]);
	await w.counts.close();
});
test('per-instance sums share the first five-minute deadline rather than debounce, then start a fresh batch', async () => {
	vi.useFakeTimers();
	const w = setup();
	await w.counts.created('a');
	await vi.advanceTimersByTimeAsync(200000);
	await w.counts.created('a');
	await w.counts.created('b');
	await vi.advanceTimersByTimeAsync(99999);
	expect(w.calls).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(w.calls).toEqual([['increment', 'a', 2]]);
	await w.counts.created('a');
	await vi.advanceTimersByTimeAsync(200000);
	expect(w.calls).toEqual([['increment', 'a', 2], ['increment', 'b', 1]]);
	await w.counts.close();
	expect(w.calls).toEqual([['increment', 'a', 2], ['increment', 'b', 1], ['increment', 'a', 1]]);
});
test('deleted remote note decrements immediately, independently of queued creates and regardless of localOnly or visibility', async () => {
	vi.useFakeTimers();
	const w = setup();
	await w.counts.created('a');
	await w.counts.deleted('a');
	expect(w.calls).toEqual([['decrement', 'a', 1]]);
	await w.counts.close();
	expect(w.calls).toEqual([['decrement', 'a', 1], ['increment', 'a', 1]]);
});
test('timer removes batch before its held write; close drains fired writes and flushes fresh batch without retrying rejection', async () => {
	vi.useFakeTimers();
	const held = deferred();
	let fail = true;
	const w = setup({ increment: vi.fn(async () => {
			if (fail) {
				fail = false;
				await held.promise;
				throw new Error('increment');
			}
		}) });
	await w.counts.created('a');
	await vi.advanceTimersByTimeAsync(300000);
	await w.counts.created('a');
	let done = false;
	const closing = w.counts.close().then(() => {
		done = true;
	});
	await Promise.resolve();
	expect(done).toBe(false);
	expect(w.ports.increment).toHaveBeenCalledTimes(2);
	held.resolve();
	await closing;
	expect(w.ports.onError).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(300000);
	expect(w.ports.increment).toHaveBeenCalledTimes(2);
});
test('registration/decrement errors propagate to independent lifecycle owner, increment failure is diagnosed and dropped', async () => {
	vi.useFakeTimers();
	const w = setup();
	vi.mocked(w.ports.fetchOrRegister).mockRejectedValueOnce(new Error('register'));
	await expect(w.counts.created('a')).rejects.toThrow('register');
	vi.mocked(w.ports.decrement).mockRejectedValueOnce(new Error('decrement'));
	await expect(w.counts.deleted('a')).rejects.toThrow('decrement');
	vi.mocked(w.ports.increment).mockRejectedValueOnce(new Error('increment'));
	await w.counts.created('a');
	await w.counts.close();
	expect(w.ports.onError).toHaveBeenCalledTimes(1);
	expect(w.ports.increment).toHaveBeenCalledTimes(1);
});
const sourceCounters = (JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/note/derived-updates/instance-counter-observations.json', import.meta.url), 'utf8')) as {
	observations: {
		id: string;
		calls: {
			method: string;
			args?: unknown;
		}[];
	}[];
}).observations.filter(row => row.id.startsWith('batch-') || row.id.startsWith('timer-') || row.id.startsWith('shutdown-') || row.id === 'source-node-env-test-zero-delay');
test.each(sourceCounters)('fixed-source direct instance ID/column/delta comparison: $id', async (row) => {
	vi.useFakeTimers();
	const calls: unknown[] = [];
	const held = deferred();
	const rejected = row.id.includes('reject');
	let first = true;
	const w = setup({
		delayMs: row.id.includes('zero-delay') ? 0 : 300000, increment: async (id, value) => {
			calls.push({ where: { id }, column: 'notesCount', value });
			if (row.id.startsWith('timer-inflight') && first) {
				first = false;
				await held.promise;
			}
			if (rejected) {
				throw new Error('write');
			}
		}
	});
	if (row.id === 'batch-first-deadline-not-debounce') {
		await w.counts.created('a');
		await vi.advanceTimersByTimeAsync(100000);
		await w.counts.created('a');
		await vi.advanceTimersByTimeAsync(100000);
		await w.counts.created('a');
		await vi.advanceTimersByTimeAsync(100000);
	} else if (row.id === 'batch-independent-instance-deadlines') {
		await w.counts.created('a');
		await vi.advanceTimersByTimeAsync(100000);
		await w.counts.created('b');
		await vi.advanceTimersByTimeAsync(200000);
	} else if (row.id.startsWith('timer-inflight')) {
		await w.counts.created('a');
		await vi.advanceTimersByTimeAsync(300000);
		await w.counts.created('a');
		await w.counts.created('a');
	} else if (row.id.startsWith('shutdown-')) {
		await w.counts.created('a');
		await w.counts.created('b');
		await w.counts.created('b');
	} else {
		await w.counts.created('a');
		await vi.advanceTimersByTimeAsync(row.id.includes('zero-delay') ? 0 : 300000);
	}
	let closed = false;
	const closing = w.counts.close().then(() => {
		closed = true;
	});
	if (row.id.startsWith('timer-inflight')) {
		await Promise.resolve();
		expect(closed).toBe(false);
		held.resolve();
	}
	await closing;
	await w.counts.close();
	expect(calls).toEqual(row.calls.filter(call => call.method === 'instance-increment').map(call => call.args));
});
