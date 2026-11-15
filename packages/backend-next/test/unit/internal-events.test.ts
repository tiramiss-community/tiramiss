/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';
import { openInternalEvents } from '../../src/platform/internal-events.js';
const state = vi.hoisted(() => ({ subscriber: undefined as unknown, topics: [] as string[], release: undefined as (() => void) | undefined, hold: false, fail: '' }));
vi.mock('ioredis', async () => {
	const { EventEmitter } = await import('node:events');
	return { Redis: class extends EventEmitter {
		status = 'wait';
		constructor() {
			super(); state.subscriber = this;
		}
		async connect() {
			if (state.fail === 'connect') {
				throw new Error('connect');
			}
			this.status = 'ready'; this.emit('ready');
		}
		async subscribe(...topics: string[]) {
			state.topics = topics;
			if (state.fail === 'subscribe') {
				throw new Error('subscribe');
			}
			if (state.hold) {
				await new Promise<void>(resolve => {
					state.release = resolve;
				});
			}
		}
		disconnect() {
			this.status = 'end'; this.emit('end');
		}
	} };
});
beforeEach(() => {
	state.topics = []; state.release = undefined; state.hold = false; state.fail = '';
});
const options = () => ({ subscriberConfig: { host: 'localhost', port: 6379, db: 0, prefix: 'prefix' }, url: 'https://host.test:444', privateRoleTopic: 'prefix:backend-next:role-materials:v1', onError: vi.fn() });
const subscriber = () => state.subscriber as EventEmitter & { status: string };
const send = (data: unknown, topic = 'host.test:444') => subscriber().emit('message', topic, typeof data === 'string' ? data : JSON.stringify(data));
const event = { channel: 'internal', message: { type: 'roleUpdated', body: { id: 'role' } } };

test('exact topics and envelope isolate consumers, malformed traffic and handler failures', async () => {
	const opts = options(); const receiver = await openInternalEvents(opts);
	expect(state.topics).toEqual(['host.test:444', 'prefix:backend-next:role-materials:v1']);
	const seen: unknown[] = []; const privateSeen: unknown[] = [];
	receiver.register({ onInternal: e => {
		e.body.id = 'mutated'; throw new Error('sync');
	} });
	receiver.register({ onInternal: async () => {
		throw new Error('async');
	} });
	const unregister = receiver.register({ onInternal: e => {
		seen.push(e);
	}, onRoleChange: e => {
		privateSeen.push(e);
	} });
	for (const malformed of ['{', 'null', '[]', '1', '{}', { channel: 'internal', message: null }, { channel: 'internal', message: { type: 'roleUpdated', body: [] } }, { channel: 'notes', message: event.message }]) {
		send(malformed);
	}
	send(event, 'wrong'); expect(seen).toEqual([]);
	send(event); await Promise.resolve();
	expect(seen).toEqual([{ type: 'roleUpdated', body: { id: 'role' } }]);
	expect(opts.onError).toHaveBeenCalledTimes(2);
	send({ kind: 'role-definitions-changed', roleId: 'r' }, 'prefix:backend-next:role-materials:v1');
	expect(privateSeen).toHaveLength(1);
	unregister(); send(event); expect(seen).toHaveLength(1);
	await receiver.close(); await receiver.close();
	expect(subscriber().listenerCount('message')).toBe(0); expect(receiver.available()).toBe(false);
});

test('raw ready notifies late registrations and reconnect before ACK; lost/close never allow late ACK resurrection', async () => {
	const receiver = await openInternalEvents(options());
	const ready = vi.fn(); const lost = vi.fn(); receiver.register({ onReady: ready, onLost: lost });
	expect(ready).toHaveBeenCalledTimes(1); expect(receiver.available()).toBe(true);
	const generation = receiver.generation();
	subscriber().status = 'close'; subscriber().emit('close');
	expect(receiver.generation()).toBeGreaterThan(generation); expect(receiver.available()).toBe(false);
	state.hold = true; subscriber().status = 'ready'; subscriber().emit('ready');
	expect(ready).toHaveBeenCalledTimes(2); expect(receiver.available()).toBe(false);
	await receiver.close(); state.release!(); await Promise.resolve(); await Promise.resolve();
	expect(receiver.available()).toBe(false); expect(lost).toHaveBeenCalled();
});

test.each(['connect', 'subscribe'])('startup %s failure releases connection and all handlers', async mode => {
	state.fail = mode; let close!: () => Promise<void>;
	await expect(openInternalEvents({ ...options(), registerCleanup: value => {
		close = value;
	} })).rejects.toThrow(mode);
	expect(subscriber().status).toBe('end'); expect(subscriber().listenerCount('message')).toBe(0); await close();
});

test('stop while initial subscribe is pending leaves returned receiver unavailable', async () => {
	state.hold = true; let close!: () => Promise<void>;
	const pending = openInternalEvents({ ...options(), registerCleanup: value => {
		close = value;
	} });
	await vi.waitFor(() => expect(state.release).toBeDefined()); await close(); state.release!();
	const receiver = await pending; expect(receiver.available()).toBe(false);
});
