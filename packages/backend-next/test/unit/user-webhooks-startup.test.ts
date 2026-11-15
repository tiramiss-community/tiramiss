/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { testConfig } from '../helpers/database.js';
import type { EntityManager } from 'typeorm';

const state = vi.hoisted(() => ({ disconnected: false, release: undefined as (() => void) | undefined }));
vi.mock('ioredis', () => ({ Redis: class extends EventEmitter {
	status = 'wait';
	async connect() {
		this.status = 'ready'; this.emit('ready');
	}
	async subscribe() {
		await new Promise<void>(resolve => {
			state.release = resolve;
		});
	}
	disconnect() {
		state.disconnected = true; this.status = 'end'; this.emit('end');
	}
} }));

test('subscriber cleanup is registered before the pending subscribe completes', async () => {
	const { openUserWebhooks } = await import('../../src/platform/user-webhooks.js');
	let cleanup: (() => Promise<void>) | undefined;
	const pending = openUserWebhooks({ manager: {} as EntityManager, redis: testConfig().redis, url: 'https://example.test', timeoutMs: 10, enqueue: async () => {}, registerCleanup: value => {
		cleanup = value;
	} });
	await vi.waitFor(() => expect(state.release).toBeDefined());
	expect(cleanup).toBeDefined();
	await cleanup!();
	expect(state.disconnected).toBe(true);
	state.release!();
	const hooks = await pending;
	await expect(hooks.enqueue('owner', 'note', {})).rejects.toThrow('closed');
});
