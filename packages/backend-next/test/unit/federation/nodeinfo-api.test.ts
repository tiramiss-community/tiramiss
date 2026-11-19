/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createNodeInfoApi } from '../../../src/http/nodeinfo-api.js';
import { createWellKnownApi } from '../../../src/http/well-known-api.js';
import { nodeInfoSource } from '../../helpers/nodeinfo-source.js';

for (const scenario of [...new Set(nodeInfoSource.observations.map(o => o.scenario))]) {
	test(`literal pinned NodeInfo HTTP sequence ${scenario}`, async () => {
		const observations = nodeInfoSource.observations.filter(o => o.scenario === scenario);
		let current = observations[0];
		let now = 1800000000000;
		const calls: unknown[][] = [];
		const logger = { error: vi.fn() };
		const invoke = (name: string, args: unknown[]) => {
			calls.push([name, ...args]);
			if (current.step.fault === name) {
				throw Error(`private ${name} diagnostic`);
			}
		};
		const app = createNodeInfoApi({
			selfUrl: 'https://local.test:8443', softwareVersion: '2026.10.1-alpha.0', clock: () => now, logger,
			federationEnabled: async () => current.meta.federation !== 'none',
			readNotes: async () => {
				invoke('notes', ['hour', 1, null]);
				return current.step.changed ? 52 : 42;
			},
			readUsers: async () => {
				invoke('users', ['hour', 1, null]);
				return current.step.changed ? 17 : 7;
			},
			readSettings: async () => {
				invoke('meta', [true]);
				return { ...current.meta, ...(current.step.changed ? { name: 'Changed instance' } : {}) };
			},
			readProxyAccountName: async () => {
				invoke('proxy', ['proxy']);
				return 'system.proxy';
			},
		});
		for (current of observations) {
			now += current.step.advance ?? 0;
			calls.length = 0;
			logger.error.mockClear();
			const response = await app.request(current.step.path, { method: current.step.method ?? 'GET' });
			expect(response.status).toBe(current.status);
			for (const [key, value] of Object.entries(current.headers)) {
				// The existing Hono error/404 body policy differs from Fastify.
				if (response.status === 200 || key !== 'content-type') {
					expect(response.headers.get(key), key).toBe(value);
				}
			}
			if (current.body !== null) {
				expect(await response.json()).toEqual(current.body);
			} else if (current.step.method === 'HEAD' || response.status === 500) {
				expect(await response.text()).toBe('');
			}
			expect(calls).toEqual(current.calls);
			if (current.step.fault) {
				expect(logger.error).toHaveBeenCalledExactlyOnceWith('nodeinfo.failed', { classification: 'unexpected-failure', stage: `${current.step.fault}-read` });
			} else {
				expect(logger.error).not.toHaveBeenCalled();
			}
		}
	});
}

test.each(['all', 'none', 'fault'])('discovery uses federation=%s and common well-known headers independently of document cache', async federation => {
	const federationEnabled = vi.fn(async () => {
		if (federation === 'fault') {
			throw Error('private Meta failure');
		}
		return federation !== 'none';
	});
	const logger = { error: vi.fn() };
	const readNotes = vi.fn();
	const parts = { selfUrl: 'https://local.test:8443', federationEnabled, logger };
	const app = createWellKnownApi(parts).route('/', createNodeInfoApi({ ...parts, softwareVersion: 'test', clock: Date.now, readNotes, readUsers: vi.fn(), readSettings: vi.fn(), readProxyAccountName: vi.fn() }));
	for (const observation of nodeInfoSource.discovery.filter(o => o.federation === federation)) {
		const method = observation.method;
		const response = await app.request('/.well-known/nodeinfo', { method });
		expect(response.status).toBe(observation.status);
		for (const [key, value] of Object.entries(observation.headers)) {
			if (response.status !== 500 || key !== 'content-type') {
				expect(response.headers.get(key), key).toBe(value);
			}
		}
		if (response.status === 200) {
			expect(await response.clone().text()).toBe(observation.body);
		}
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Cache-Control')).toBeNull();
		expect(response.headers.get('Vary')).toBeNull();
		if (method === 'GET' && federation === 'all') {
			expect(await response.json()).toEqual({ links: [
				{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://local.test:8443/nodeinfo/2.1' },
				{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: 'https://local.test:8443/nodeinfo/2.0' },
			] });
		} else {
			expect(await response.text()).toBe('');
		}
	}
	expect(readNotes).not.toHaveBeenCalled();
	expect(federationEnabled).toHaveBeenCalledTimes(2);
});

test('concurrent cold requests retain independent source-style reads and cache on completion', async () => {
	let finish!: () => void;
	const waiting = new Promise<void>(resolve => {
		finish = resolve;
	});
	const readNotes = vi.fn(async () => {
		await waiting;
		return 1;
	});
	const sample = nodeInfoSource.observations[0].meta;
	const app = createNodeInfoApi({ selfUrl: 'https://local.test', softwareVersion: 'test', clock: Date.now, federationEnabled: async () => true, logger: { error: vi.fn() }, readNotes, readUsers: async () => 2, readSettings: async () => sample, readProxyAccountName: async () => 'system.proxy' });
	const first = app.request('/nodeinfo/2.1');
	const second = app.request('/nodeinfo/2.0');
	await vi.waitFor(() => expect(readNotes).toHaveBeenCalledTimes(2));
	finish();
	expect((await first).status).toBe(200);
	expect((await second).status).toBe(200);
	const cached = await app.request('/nodeinfo/2.1');
	expect((await cached.json() as { software: { repository?: string; homepage: string } }).software).toMatchObject({ homepage: 'https://misskey-hub.net' });
	expect(readNotes).toHaveBeenCalledTimes(2);
});
