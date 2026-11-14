/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createActivityPubOutboxApi } from '../../../src/http/activitypub-outbox-api.js';
import type { NotePublicationRow } from '../../../src/modules/federation/public.js';

function fixture() {
	const parts = {
		federationEnabled: vi.fn(async () => true), readOutbox: vi.fn(async () => ({ type: 'OrderedCollection' })),
		readLocalActivityNote: vi.fn(async () => ({ id: 'note' } as NotePublicationRow)), renderActivity: vi.fn(async () => ({ type: 'Create' })), logger: { error: vi.fn() },
	};
	return { parts, app: createActivityPubOutboxApi(parts) };
}

test.each([
	['', false, null, null], ['?page=true', true, null, null], ['?page=TRUE', false, null, null],
	['?page=true&page=true', false, null, null], ['?page[]=true', false, null, null],
	['?page=true&since_id=', true, '', null], ['?page=true&until_id=', true, null, ''],
	['?%70age=true&since%5Fid=a+b', true, 'a b', null], ['?since_id=%ZZ', false, '%ZZ', null],
	['?since_id=%E0%A4%A', false, '%E0%A4%A', null], ['?since_id[]=x', false, null, null],
] as const)('raw query %s preserves source coercion', async (suffix, page, sinceId, untilId) => {
	const { app, parts } = fixture();
	const response = await app.request(`/users/alice/outbox${suffix}`);
	expect(response.status).toBe(200);
	expect(parts.readOutbox).toHaveBeenCalledExactlyOnceWith('alice', page, { sinceId, untilId });
	expect(response.headers.get('cache-control')).toBe(page ? null : 'public, max-age=180');
	expect(response.headers.get('vary')).toBeNull();
});
test.each(['?since_id=&until_id=', '?since_id=x&since_id=', '?until_id=&until_id=', '?page=false&until_id=x&since_id=y'])('invalid query %s fails before local user lookup', async suffix => {
	const { app, parts } = fixture();
	const response = await app.request(`/users/gone/outbox${suffix}`);
	expect(response.status).toBe(400);
	expect(await response.text()).toBe('');
	expect(parts.readOutbox).not.toHaveBeenCalled();
	parts.federationEnabled.mockResolvedValue(false);
	expect((await app.request(`/users/gone/outbox${suffix}`)).status).toBe(403);
});
test.each(['outbox', 'activity'])('raw path validation for %s precedes federation and CORS including empty and UTF16', async route => {
	const { app, parts } = fixture();
	parts.federationEnabled.mockResolvedValue(false);
	const path = (value: string) => route === 'outbox' ? `/users/${value}/outbox` : `/notes/${value}/activity`;
	for (const raw of ['%', '%ZZ', '%C0%AF', '%E0%A4%A']) {
		const response = await app.request(path(raw));
		expect(response.status).toBe(400);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	}
	for (const raw of ['x'.repeat(101), encodeURIComponent('😀'.repeat(50) + 'x')]) {
		const response = await app.request(path(raw));
		expect(response.status).toBe(414);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	}
	expect(parts.federationEnabled).not.toHaveBeenCalled();
	for (const raw of ['', 'x'.repeat(100), encodeURIComponent('😀'.repeat(50)), '%2F', '%252F']) {
		expect((await app.request(path(raw))).status).toBe(403);
	}
});
test.each(['text/html', 'application/json', '*/*', 'application/activity+json;q=0', 'application/ld+json'])('Accept %s still publishes activities and outbox', async accept => {
	const { app } = fixture();
	for (const path of ['/users/alice/outbox', '/notes/note/activity']) {
		const response = await app.request(path, { headers: { Accept: accept } });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(accept === 'application/ld+json' ? 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8' : 'application/activity+json; charset=utf-8');
		expect(response.headers.get('vary')).toBe(path.includes('/notes/') ? 'Accept' : null);
	}
});
test('activity rendering failure preserves success cache; outbox failure does not gain cache', async () => {
	const { app, parts } = fixture();
	parts.renderActivity.mockRejectedValue(new Error('private diagnostic'));
	parts.readOutbox.mockRejectedValue(new Error('private diagnostic'));
	for (const path of ['/users/alice/outbox?page=true', '/notes/note/activity']) {
		const response = await app.request(path);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
		expect(response.headers.get('cache-control')).toBe(path.includes('/notes/') ? 'public, max-age=180' : null);
	}
});
test.each(['/users/alice/outbox', '/notes/note/activity'])('HEAD performs work; OPTIONS %s bypasses business hooks and CORS', async path => {
	const { app, parts } = fixture();
	const head = await app.request(path, { method: 'HEAD' });
	expect(head.status).toBe(200);
	expect(await head.text()).toBe('');
	expect(parts.federationEnabled).toHaveBeenCalledTimes(1);
	const options = await app.request(path, { method: 'OPTIONS' });
	expect(options.status).toBe(404);
	expect(options.headers.get('access-control-allow-origin')).toBeNull();
	expect(parts.federationEnabled).toHaveBeenCalledTimes(1);
});
test.each(['/users/%ZZ/outbox', `/notes/${'x'.repeat(101)}/activity`, `/users/${'x'.repeat(101)}/outbox`])('OPTIONS %s rejects malformed encoding but preserves method fallback for long parameters', async path => {
	const { app, parts } = fixture();
	const response = await app.request(path, { method: 'OPTIONS' });
	expect(response.status).toBe(path.includes('%ZZ') ? 400 : 404);
	expect(response.headers.get('access-control-allow-origin')).toBeNull();
	expect(parts.federationEnabled).not.toHaveBeenCalled();
});
