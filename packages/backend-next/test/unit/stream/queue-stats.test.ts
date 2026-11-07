/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createStreamConnection, emptyStreamFacts } from '../../../src/modules/stream/public.js';
import { createQueueStats } from '../../../src/platform/queue-stats.js';
import type { QueueStatsSample } from '../../../src/modules/queue/public.js';

const corpus = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/queue-admin/observations.json', import.meta.url), 'utf8')) as { observations: { id: string; layer: string; input: any; expected: any }[] };
const counts = { active: 1, waiting: 2, delayed: 3 };
const sample = { deliver: { activeSincePrevTick: 0, ...counts }, inbox: { activeSincePrevTick: 0, ...counts } };
const turn = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => {
	vi.useRealTimers();
});

test.each(corpus.observations.filter((o: any) => o.id.startsWith('stream-connection-')))('fixed-source $id public shared channel', async (observation: any) => {
	const messages: unknown[] = [];
	const listeners = new Set<(value: QueueStatsSample) => void>();
	const stats = {
		subscribe(listener: (value: QueueStatsSample) => void) {
			listeners.add(listener); return () => listeners.delete(listener);
		}, readLog(length: number) {
			return [sample].slice(0, length);
		}
	};
	const connection = createStreamConnection({ facts: () => emptyStreamFacts(observation.input.actor === 'anonymous' ? null : 'me'), now: () => 1000, send: (value: unknown) => messages.push(value), repack: async () => null, reaction: async () => undefined, queueStats: stats });
	await connection.receive({ type: 'connect', body: observation.input.connect });
	await connection.receive({ type: 'connect', body: { ...observation.input.connect, id: observation.input.duplicateId } });
	await connection.receive({ type: 'ch', body: { id: 'channel-id', type: 'requestLog', body: observation.input.requestLog } });
	expect(messages).toEqual(observation.expected.messages);
	expect(listeners.size).toBe(observation.expected.channelCount);
	await connection.receive({ type: 'disconnect', body: { id: 'channel-id' } });
	expect(listeners.size).toBe(0);
});

test('malformed log messages do not read history, replacement and dispose remove subscriptions', async () => {
	const listeners = new Set<(value: QueueStatsSample) => void>();
	const messages: unknown[] = [];
	let reads = 0;
	const connection = createStreamConnection({
		facts: () => emptyStreamFacts('me'), now: () => 0, send: (value: unknown) => messages.push(value), repack: async () => null, reaction: async () => undefined,
		queueStats: {
			subscribe(listener: (value: QueueStatsSample) => void) {
				listeners.add(listener); return () => listeners.delete(listener);
			}, readLog() {
				reads++; return [sample];
			}
		}
	});
	await connection.receive({ type: 'connect', body: { id: 'stats', channel: 'queueStats' } });
	const invalid = corpus.observations.find(o => o.id === 'stream-invalid-log-ignored')!;
	for (const body of invalid.input.invalidBodies) {
		await connection.receive({ type: 'channel', body: { id: 'stats', type: 'requestLog', body } });
	}
	await connection.receive({ type: 'channel', body: { id: 'stats', type: invalid.input.unknownOperation, body: { id: 'r', length: 1 } } });
	expect(reads).toBe(0);
	expect({ messages }).toEqual(invalid.expected);
	for (const listener of listeners) {
		listener(sample);
	}
	expect(messages).toEqual([{ type: 'channel', body: { id: 'stats', type: 'stats', body: sample } }]);
	await connection.receive({ type: 'connect', body: { id: 'stats', channel: 'main' } });
	expect(listeners.size).toBe(0);
	await connection.receive({ type: 'connect', body: { id: 'stats', channel: 'queueStats' } });
	connection.dispose();
	expect(listeners.size).toBe(0);
});

test('sampler ticks immediately, emits before inserting history, counts active events and resets', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	let active!: (queue: 'deliver' | 'inbox') => void;
	let historyAtEmission = -1;
	const messages: unknown[] = [];
	const sampler = createQueueStats({
		counts: async () => counts, subscribeActive: (listener: typeof active) => {
			active = listener; return () => { };
		}, onError: (error: unknown) => {
			throw error;
		}
	});
	await turn();
	expect(sampler.readLog(100)).toEqual([sample]);
	sampler.subscribe((value: unknown) => {
		historyAtEmission = sampler.readLog(100).length; messages.push({ type: 'channel', body: { id: 'channel-id', type: 'stats', body: value } });
	});
	active('deliver'); active('deliver'); active('inbox');
	await vi.advanceTimersByTimeAsync(9999);
	expect(messages).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(historyAtEmission).toBe(1);
	messages.push({ type: 'channel', body: { id: 'channel-id', type: 'statsLog', body: sampler.readLog(1) } });
	expect(messages).toEqual(corpus.observations.find((o: any) => o.id === 'stream-active-count-and-log')!.expected.messages);
	await vi.advanceTimersByTimeAsync(10000);
	expect(sampler.readLog(1)).toEqual([sample]);
	expect(messages.slice(-1)).toEqual(corpus.observations.find(o => o.id === 'stream-active-reset')!.expected.messages);
	await sampler.close();
});

test('fixed-source stream-disconnect-unsubscribes stops subsequent delivery', async () => {
	const observation = corpus.observations.find(o => o.id === 'stream-disconnect-unsubscribes')!;
	const listeners = new Set<(value: typeof sample) => void>();
	const messages: unknown[] = [];
	const connection = createStreamConnection({
		facts: () => emptyStreamFacts(null), now: () => 0, send: value => messages.push(value), repack: async () => null, reaction: async () => undefined,
		queueStats: {
			subscribe(listener) {
				listeners.add(listener); return () => {
					listeners.delete(listener);
				};
			}, readLog() {
				return [];
			}
		}
	});
	await connection.receive({ type: 'connect', body: { id: observation.input.disconnectId, channel: 'queueStats' } });
	await connection.receive({ type: 'disconnect', body: { id: observation.input.disconnectId } });
	for (const listener of listeners) {
		listener(sample);
	}
	expect({ messages, statsListeners: listeners.size }).toEqual(observation.expected);
});

test.each(corpus.observations.filter((o: any) => o.id.startsWith('stream-history-')))('fixed-source $id newest-first bounded history and JS slicing', async (observation: any) => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	let active = 0;
	const sampler = createQueueStats({
		counts: async () => ({ ...counts, active }), subscribeActive: () => () => { }, onError: (error: unknown) => {
			throw error;
		}
	});
	await turn();
	for (active = 100; active < 300; active++) {
		await vi.advanceTimersByTimeAsync(10000);
	}
	const log = sampler.readLog(observation.input.requestLog.length);
	expect({ type: 'statsLog', count: log.length, first: log[0] ?? null, last: log.at(-1) ?? null }).toEqual(observation.expected);
	await sampler.close();
});

test('close stops ticks and waits started reads without publishing late samples', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	let release!: (value: typeof counts) => void;
	let reads = 0;
	let unsubscribed = false;
	const sampler = createQueueStats({
		counts: async () => {
			reads++; return new Promise(resolve => {
				release = resolve;
			});
		}, subscribeActive: () => () => {
			unsubscribed = true;
		}, onError() { }
	});
	const sent: unknown[] = [];
	sampler.subscribe((value: unknown) => sent.push(value));
	let closed = false;
	const closing = sampler.close().then(() => {
		closed = true;
	});
	await turn();
	expect(closed).toBe(false);
	expect(unsubscribed).toBe(true);
	release(counts); await turn(); release(counts);
	await closing;
	await vi.advanceTimersByTimeAsync(10000);
	expect(reads).toBe(2);
	expect(sent).toEqual([]);
});
