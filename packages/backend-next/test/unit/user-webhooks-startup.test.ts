/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { testConfig } from '../helpers/database.js';
import type { EntityManager } from 'typeorm';

const state = vi.hoisted(() => ({ disconnected: false, release: undefined as (() => void) | undefined }));
vi.mock('ioredis', () => ({ Redis: class {
	on() {
		return this;
	}
	async connect() { }
	async subscribe() {
		await new Promise<void>(resolve => {
			state.release = resolve;
		});
	}
	disconnect() {
		state.disconnected = true;
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
	await pending;
});
