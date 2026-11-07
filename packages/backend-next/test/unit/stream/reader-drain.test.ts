/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { MiFollowing, MiUser } from 'backend-upstream/entities';
import { createStreamingReader } from '../../../src/platform/database/streaming.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
 resolve = done; 
});
	return { promise, resolve };
}

const logger = { info() {}, error() {} };
test('failed profile refresh waits for every started relationship read before rejecting', async () => {
	const pending = deferred<never[]>();
	const manager = { getRepository(entity: unknown) {
		return { find: async () => [{ ugcVisibilityForVisitor: 'public' }], findOneByOrFail: async () => {
 throw new Error('PROFILE_FAILED'); 
}, findBy: () => entity === MiFollowing ? pending.promise : Promise.resolve([]) };
	} } as unknown as EntityManager;
	const reader = createStreamingReader(manager, {} as Redis, logger, { url: 'http://example.test', createdAtFromId: () => 0 });
	let finished = false;
	const read = reader.readFacts('viewer').finally(() => {
 finished = true; 
});
	const failure = expect(read).rejects.toThrow('PROFILE_FAILED');
	await new Promise(resolve => setImmediate(resolve));
	expect(finished).toBe(false);
	pending.resolve([]);
	await failure;
});

test('failed wake-up write waits for the following flag write before rejecting', async () => {
	const pending = deferred<void>();
	const started = deferred<void>();
	let updates = 0;
	const manager = { getRepository(entity: unknown) {
		return { findOneByOrFail: async () => ({ isHibernated: true }), update: async () => {
			if (entity === MiUser) {
				if (++updates === 2) {
 throw new Error('WAKE_FAILED'); 
}
			} else {
 started.resolve(); await pending.promise; 
}
		} };
	} } as unknown as EntityManager;
	const reader = createStreamingReader(manager, {} as Redis, logger, { url: 'http://example.test', createdAtFromId: () => 0 });
	let finished = false;
	const write = reader.touchActivity('viewer').finally(() => {
 finished = true; 
});
	const failure = expect(write).rejects.toThrow('WAKE_FAILED');
	await started.promise;
	await new Promise(resolve => setImmediate(resolve));
	expect(finished).toBe(false);
	pending.resolve();
	await failure;
});
