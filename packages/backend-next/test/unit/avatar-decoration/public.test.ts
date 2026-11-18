/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createPublicAvatarDecorations } from '../../../src/modules/avatar-decoration/public.js';
import { createAvatarDecorationCache } from '../../../src/platform/avatar-decoration-cache.js';
import { createAvatarDecorationsApi } from '../../../src/http/avatar-decorations-api.js';
import source from '../../../../../docs/superpowers/compatibility/avatar-decorations/observations.json' with { type: 'json' };

for (const sample of source.projection) {
	test(`literal pinned callback projection: authenticated=${sample.authenticated}`, async () => {
		const getAll = vi.fn(async () => source.rows);
		const list = createPublicAvatarDecorations({ getAll, readRoles: async () => source.roles });
		expect(await list(sample.authenticated)).toEqual(sample.result);
		expect(getAll).toHaveBeenCalledExactlyOnceWith(true);
	});
}

test('missing visibility fails closed for guests while authenticated callers retain existing roles', async () => {
	const list = createPublicAvatarDecorations({ getAll: async () => source.rows, readRoles: async () => [{ id: 'public' }] });
	expect((await list(false))[0].roleIdsThatCanBeUsedThisDecoration).toEqual([]);
	expect((await list(true))[0].roleIdsThatCanBeUsedThisDecoration).toEqual(['public', 'public']);
});

test('cache read counts and failures match the literal pinned service/cache timeline', async () => {
	let at = 0;
	let reads = 0;
	let fail = false;
	let receive!: (event: { type: string; body: Record<string, unknown> }) => void | Promise<void>;
	const cache = createAvatarDecorationCache({ clock: () => at, read: async () => {
		reads++;
		if (fail) {
			throw new Error('DB unavailable'); 
		}
		return source.rows;
	}, events: { register(handler) {
		receive = handler.onInternal!; return () => {}; 
	} } });
	for (const sample of source.timeline) {
		if (sample.label === 'exact TTL') {
			at = 1800000; 
		}
		if (sample.label === 'expired') {
			at++; 
		}
		if (sample.label.startsWith('avatar') || sample.label === 'unrelated') {
			await receive({ type: sample.label, body: {} }); 
		}
		fail = sample.label === 'forced failure';
		let error = null;
		try {
			await cache.getAll(fail); 
		} catch (e) {
			error = (e as Error).message; 
		}
		expect({ label: sample.label, reads, error }).toEqual(sample);
	}
	await cache.close();
});

for (const authenticated of [false, true]) {
	test(`public common gate returns role visibility for ${authenticated ? 'native user' : 'guest'}`, async () => {
		const list = createPublicAvatarDecorations({ getAll: async () => source.rows, readRoles: async () => source.roles });
		const app = createAvatarDecorationsApi(list, { authenticate: async () => authenticated ? { credential: { userId: 'viewer', native: true } } : null, logger: { error: vi.fn(), info: vi.fn() } });
		const response = await app.request('/api/get-avatar-decorations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(source.projection.find(s => s.authenticated === authenticated)!.result);
	});
}

test('database errors propagate as common API internal errors and empty list remains an array', async () => {
	const getAll = vi.fn(async () => []);
	const app = createAvatarDecorationsApi(createPublicAvatarDecorations({ getAll, readRoles: async () => [] }), { authenticate: async () => null, logger: { error: vi.fn(), info: vi.fn() } });
	const request = () => app.request('/api/get-avatar-decorations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	expect(await (await request()).json()).toEqual([]);
	getAll.mockRejectedValueOnce(new Error('DB unavailable'));
	const response = await request();
	expect(response.status).toBe(500);
	expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
});
