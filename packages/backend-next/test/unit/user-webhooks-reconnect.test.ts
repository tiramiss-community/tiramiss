/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { openUserWebhooks } from '../../src/platform/user-webhooks.js';
import { testConfig } from '../helpers/database.js';
import type { EntityManager } from 'typeorm';

const state = vi.hoisted(() => ({ listeners: new Map<string, (...args: unknown[]) => void>() }));
vi.mock('ioredis', () => ({ Redis: class {
	on(event: string, listener: (...args: unknown[]) => void) {
		state.listeners.set(event, listener);
		return this;
	}
	async connect() {
		state.listeners.get('ready')?.();
	}
	async subscribe() { }
	disconnect() { }
} }));

beforeEach(() => {
	state.listeners.clear();
});

const hook = { id: 'hook', userId: 'owner', url: 'https://example.test/hook', secret: '', active: true, on: ['note'] };

async function open(findBy: ReturnType<typeof vi.fn>) {
	const enqueue = vi.fn(async () => {});
	const manager = { getRepository: () => ({ findBy }) } as unknown as EntityManager;
	const hooks = await openUserWebhooks({ manager, redis: testConfig().redis, url: 'https://example.test', timeoutMs: 100, enqueue });
	return { hooks, enqueue };
}

test('the next enqueue reloads active hooks after reconnect, while ordinary cache hits do not query again', async () => {
	const findBy = vi.fn().mockResolvedValueOnce([hook]).mockResolvedValue([]);
	const { hooks, enqueue } = await open(findBy);
	try {
		await hooks.enqueue('owner', 'note', {});
		await hooks.enqueue('owner', 'note', {});
		expect(findBy).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledTimes(2);
		state.listeners.get('ready')?.();
		await hooks.enqueue('owner', 'note', {});
		expect(findBy).toHaveBeenCalledTimes(2);
		expect(enqueue).toHaveBeenCalledTimes(2);
	} finally {
		await hooks.close();
	}
});

test('a read started before reconnect cannot restore the old active hooks', async () => {
	let release!: (rows: typeof hook[]) => void;
	const oldRead = new Promise<typeof hook[]>(resolve => {
		release = resolve;
	});
	const findBy = vi.fn().mockReturnValueOnce(oldRead).mockResolvedValue([]);
	const { hooks, enqueue } = await open(findBy);
	try {
		const pending = hooks.enqueue('owner', 'note', {});
		await vi.waitFor(() => expect(findBy).toHaveBeenCalledTimes(1));
		state.listeners.get('ready')?.();
		await hooks.enqueue('owner', 'note', {});
		release([hook]);
		await pending;
		await hooks.enqueue('owner', 'note', {});
		expect(findBy).toHaveBeenCalledTimes(2);
		expect(enqueue).not.toHaveBeenCalled();
	} finally {
		release([]);
		await hooks.close();
	}
});

test('a failed reload after reconnect rejects without using stale hooks and can be retried', async () => {
	const findBy = vi.fn().mockResolvedValueOnce([hook]).mockRejectedValueOnce(new Error('read failed')).mockResolvedValue([]);
	const { hooks, enqueue } = await open(findBy);
	try {
		await hooks.enqueue('owner', 'note', {});
		state.listeners.get('ready')?.();
		await expect(hooks.enqueue('owner', 'note', {})).rejects.toThrow('read failed');
		await hooks.enqueue('owner', 'note', {});
		expect(findBy).toHaveBeenCalledTimes(3);
		expect(enqueue).toHaveBeenCalledTimes(1);
	} finally {
		await hooks.close();
	}
});

test('a disable message received during the reconnect reload is not overwritten by its earlier snapshot', async () => {
	let release!: (rows: typeof hook[]) => void;
	const oldRead = new Promise<typeof hook[]>(resolve => {
		release = resolve;
	});
	const findBy = vi.fn().mockResolvedValueOnce([hook]).mockReturnValueOnce(oldRead).mockResolvedValue([]);
	const { hooks, enqueue } = await open(findBy);
	try {
		await hooks.enqueue('owner', 'note', {});
		state.listeners.get('ready')?.();
		const pending = hooks.enqueue('owner', 'note', {});
		await vi.waitFor(() => expect(findBy).toHaveBeenCalledTimes(2));
		state.listeners.get('message')?.('example.test', JSON.stringify({ channel: 'internal', message: { type: 'webhookUpdated', body: { ...hook, active: false } } }));
		release([hook]);
		await pending;
		await hooks.enqueue('owner', 'note', {});
		expect(enqueue).toHaveBeenCalledTimes(1);
	} finally {
		release([]);
		await hooks.close();
	}
});
