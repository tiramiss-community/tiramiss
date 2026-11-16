/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createPublicDocumentsApi } from '../../src/http/public-documents-api.js';
import type { PublicDocumentSettings } from '../../src/modules/public-documents/public.js';

const directory = new URL('../../../../docs/superpowers/compatibility/public-documents/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	config: { url: string; host: string };
	defaults: PublicDocumentSettings;
	cases: { id: string; meta: Partial<PublicDocumentSettings> }[];
};
const observations = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	cases: { id: string; responses: { path: string; status: number; contentType: string; cacheControl: string | null; body: string }[] }[];
};

for (const item of observations.cases) {
	test(`public documents match pinned listening HTTP: ${item.id}`, async () => {
		const meta = { ...corpus.defaults, ...corpus.cases.find(input => input.id === item.id)!.meta };
		const readSettings = vi.fn(async () => meta);
		const app = createPublicDocumentsApi({ readSettings, url: corpus.config.url });
		for (const expected of item.responses) {
			const response = await app.request(`${expected.path}?ignored=true`, { headers: { Accept: 'application/activity+json', Authorization: 'Bearer invalid' } });
			expect({ path: expected.path, status: response.status, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control'), body: await response.text() }).toEqual(expected);
		}
		expect(readSettings).toHaveBeenCalledTimes(3);
	});
}

test('settings are read again and HEAD has the GET headers with no body', async () => {
	let meta = corpus.defaults;
	const app = createPublicDocumentsApi({ readSettings: async () => meta, url: corpus.config.url });
	expect((await (await app.request('/manifest.json')).json()).name).toBe(corpus.config.host);
	meta = { ...meta, name: 'Updated', ugcVisibilityForVisitor: 'none' };
	expect((await (await app.request('/manifest.json')).json()).name).toBe('Updated');
	expect(await (await app.request('/robots.txt')).text()).toContain('Disallow: /notes\n');
	for (const path of ['/manifest.json', '/robots.txt', '/opensearch.xml']) {
		const get = await app.request(path);
		const head = await app.request(path, { method: 'HEAD' });
		expect(head.status).toBe(get.status);
		expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
		expect(head.headers.get('cache-control')).toBe(get.headers.get('cache-control'));
		expect(await head.text()).toBe('');
	}
});
