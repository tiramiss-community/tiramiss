/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { AuthenticationFailed } from '../../../src/modules/access/public.js';
import { createPublicEmojisApi } from '../../../src/http/public-emojis-api.js';
import { createPublicEmojis } from '../../../src/modules/emoji/public.js';

const emoji = { id: 'wave-id', name: 'wave', host: null, aliases: ['hello'], category: null, publicUrl: '', originalUrl: 'https://original.test/wave', license: null, localOnly: false, isSensitive: false, roleIdsThatCanBeUsedThisEmojiAsReaction: [] as string[] };

function setup() {
	let rows = [{ ...emoji }];
	const application = createPublicEmojis({ list: async () => rows, findLocal: async name => rows.find(row => row.name === name) ?? (() => {
		throw Error('missing emoji'); 
	})() });
	const app = createPublicEmojisApi(application, { authenticate: async token => {
		if (token === '') {
			throw new AuthenticationFailed();
		}
		if (token === 'bad') {
			throw Error('authentication database failed');
		}
		return token ? { credential: { userId: 'viewer', native: true } } : null;
	}, logger: { info() {}, error() {} } });
	return { app, setRows: (value: typeof rows) => {
		rows = value;
	} };
}

test('anonymous GET list uses the original URL and omits false and empty simple fields', async () => {
	const { app } = setup();
	const response = await app.request('/api/emojis');
	expect(response.status).toBe(200);
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
	expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	expect(response.headers.get('Content-Type')).toContain('application/json');
	expect(await response.json()).toEqual({ emojis: [{ aliases: ['hello'], name: 'wave', category: null, url: emoji.originalUrl }] });
});

test('single GET and POST preserve detailed false and empty fields and read fresh values', async () => {
	const h = setup();
	const detail = { id: emoji.id, aliases: emoji.aliases, name: emoji.name, category: null, host: null, url: emoji.originalUrl, license: null, isSensitive: false, localOnly: false, roleIdsThatCanBeUsedThisEmojiAsReaction: [] };
	expect(await (await h.app.request('/api/emoji?name=wave')).json()).toEqual(detail);
	h.setRows([{ ...emoji, publicUrl: 'https://public.test/wave', localOnly: true, isSensitive: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] }]);
	const post = await h.app.request('/api/emoji', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"wave"}' });
	expect(post.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
	expect(await post.json()).toEqual({ ...detail, url: 'https://public.test/wave', localOnly: true, isSensitive: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] });
	expect((await (await h.app.request('/api/emojis')).json()).emojis[0]).toMatchObject({ localOnly: true, isSensitive: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] });
});

test('token GET stays private, Bearer wins, duplicate query names fail validation, missing local emoji is INTERNAL_ERROR', async () => {
	const { app } = setup();
	for (const path of ['/api/emojis?i=token']) {
		const response = await app.request(path);
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
	}
	expect((await app.request('/api/emojis?i=bad', { headers: { Authorization: 'Bearer good' } })).status).toBe(200);
	for (const path of ['/api/emoji', '/api/emoji?name=wave&name=other']) {
		const response = await app.request(path);
		expect(response.status).toBe(400);
		expect((await response.json()).error.code).toBe('INVALID_PARAM');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
	}
	const missing = await app.request('/api/emoji?name=remote@remote.test');
	expect(missing.status).toBe(500);
	expect((await missing.json()).error.code).toBe('INTERNAL_ERROR');
	expect((await app.request('/api/emojis?i=bad')).status).toBe(500);
	expect((await app.request('/api/emojis?i=')).status).toBe(401);
});

test('GET preserves the complete malformed query component instead of decoding only its valid prefix', async () => {
	const h = setup();
	h.setRows([{ ...emoji, name: 'plain%ZZ' }]);
	const response = await h.app.request('/api/emoji?name=%70lain%ZZ');
	expect(response.status).toBe(500);
});
