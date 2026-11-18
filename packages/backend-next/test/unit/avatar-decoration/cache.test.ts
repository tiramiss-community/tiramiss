/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createAvatarDecorationCache } from '../../../src/platform/avatar-decoration-cache.js';
import type { InternalEvent, InternalEvents } from '../../../src/platform/internal-events.js';

function fixture() {
	let now = 0;
	let receive: ((event: InternalEvent) => void | Promise<void>) | undefined;
	const unregister = vi.fn(() => {
		receive = undefined; 
	});
	const read = vi.fn(async () => []);
	const cache = createAvatarDecorationCache({ read, clock: () => now, events: { register(handler) {
		receive = handler.onInternal;
		return unregister;
	} } as Pick<InternalEvents, 'register'> });
	return { cache, read, unregister, setTime: (value: number) => {
		now = value; 
	}, event: (type: string) => receive?.({ type, body: {} }) };
}

test('TTL is valid at exactly thirty minutes and expires one millisecond later', async () => {
	const f = fixture();
	await f.cache.getAll();
	f.setTime(1800000);
	await f.cache.getAll();
	expect(f.read).toHaveBeenCalledTimes(1);
	f.setTime(1800001);
	await f.cache.getAll();
	expect(f.read).toHaveBeenCalledTimes(2);
	await f.cache.close();
});

for (const type of ['avatarDecorationCreated', 'avatarDecorationUpdated', 'avatarDecorationDeleted']) {
	test(`${type} invalidates without trusting event payload`, async () => {
		const f = fixture();
		await f.cache.getAll();
		await f.event('unrelated');
		await f.cache.getAll();
		expect(f.read).toHaveBeenCalledTimes(1);
		await f.event(type);
		await f.cache.getAll();
		expect(f.read).toHaveBeenCalledTimes(2);
		await f.cache.close();
	});
}

test('noCache clears warm value before a failed read, and the next read retries', async () => {
	const f = fixture();
	await f.cache.getAll();
	f.read.mockRejectedValueOnce(new Error('DB unavailable'));
	await expect(f.cache.getAll(true)).rejects.toThrow('DB unavailable');
	await f.cache.getAll();
	expect(f.read).toHaveBeenCalledTimes(3);
	await f.cache.close();
});

test('close unregisters and waits for accepted reads, rejects new work, and is idempotent', async () => {
	const f = fixture();
	let release!: () => void;
	f.read.mockImplementationOnce(() => new Promise(resolve => {
		release = () => resolve([]); 
	}));
	const read = f.cache.getAll();
	let closed = false;
	const closing = f.cache.close().then(() => {
		closed = true; 
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(f.unregister).toHaveBeenCalledTimes(1);
	await expect(f.cache.getAll()).rejects.toThrow('closed');
	release();
	await read;
	await closing;
	await f.cache.close();
	expect(f.unregister).toHaveBeenCalledTimes(1);
});

test('in-flight misses remain independent and may refill after notification, with TTL starting on completion', async () => {
	const f = fixture();
	const releases: (() => void)[] = [];
	f.read.mockImplementation(() => new Promise(resolve => {
		releases.push(() => resolve([]));
	}));
	const first = f.cache.getAll();
	const second = f.cache.getAll();
	expect(f.read).toHaveBeenCalledTimes(2);
	await f.event('avatarDecorationUpdated');
	f.setTime(1000);
	releases[0]();
	releases[1]();
	await Promise.all([first, second]);
	f.setTime(1801000);
	await f.cache.getAll();
	expect(f.read).toHaveBeenCalledTimes(2);
	await f.cache.close();
});
