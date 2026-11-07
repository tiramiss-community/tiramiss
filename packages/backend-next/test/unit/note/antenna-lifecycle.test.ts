/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { openNoteAntennas } from '../../../src/platform/note-antennas.js';
const state = vi.hoisted(() => ({
	connectFailure: false, subscribeFailure: false, connects: 0, disconnects: 0, topics: [] as string[], listeners: 0
}));
vi.mock('ioredis', async () => {
	const { EventEmitter } = await import('node:events');
	return { Redis: class extends EventEmitter {
			status = 'wait';
			async connect() {
				state.connects++;
				if (state.connectFailure) {
					throw new Error('connect');
				}
				this.status = 'ready';
			}
			async subscribe(topic: string) {
				state.topics.push(topic);
				if (state.subscribeFailure) {
					throw new Error('subscribe');
				}
			}
			disconnect() {
				state.disconnects++;
				state.listeners = this.listenerCount('message');
				this.status = 'end';
				this.emit('end');
			}
		} };
});
beforeEach(() => {
	state.connectFailure = false;
	state.subscribeFailure = false;
	state.connects = 0;
	state.disconnects = 0;
	state.topics = [];
});

function options() {
	return {
		reader: { active: async () => [], followings: async () => [] }, redis: { get: async () => null, set: async () => 'OK', del: async () => 1 }, currentTime: () => 0, onError: () => { }, subscriberConfig: {
			host: '127.0.0.1', port: 6379, db: 0, prefix: 'test'
		}, url: 'https://local.example:3000', timeoutMs: 1000
	};
}

test.each(['connect', 'subscribe'] as const)('subscriber %s failure removes its listener and releases created connection, cleanup registration survives startup failure', async (mode) => {
	state.connectFailure = mode === 'connect';
	state.subscribeFailure = mode === 'subscribe';
	const cleanups: (() => Promise<void>)[] = [];
	await expect(openNoteAntennas({
		...options(), registerCleanup: close => {
			cleanups.push(close);
		}
	})).rejects.toThrow(mode);
	expect(cleanups).toHaveLength(1);
	expect(state.disconnects).toBe(1);
	expect(state.listeners).toBe(0);
	await cleanups[0]();
	expect(state.disconnects).toBe(1);
});
test('dedicated subscriber uses the instance host and disconnects exactly once after normal close', async () => {
	const cache = await openNoteAntennas(options());
	expect(state.topics).toEqual(['local.example:3000']);
	await cache.close();
	await cache.close();
	expect(state.disconnects).toBe(1);
	expect(state.listeners).toBe(0);
});
