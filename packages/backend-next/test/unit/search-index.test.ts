/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createSearchIndex } from '../../src/platform/search-index.js';
import { createLogger } from '../../src/platform/logger.js';
import { gate, searchGateway } from '../helpers/search-gateway.js';
const note = { id: 'n', userId: 'a', userHost: null, text: 'hello', cw: null, channelId: null, tags: [], visibility: 'public' };

test('actual SDK sends independent adds while settings acceptance is blocked and close drains accepted requests', async () => {
	const held = gate();
	const gateway = await searchGateway(async request => {
		if (request.method === 'PATCH') {
			await held.promise;
		}
	});
	const search = createSearchIndex({ fulltextSearch: { provider: 'meilisearch' }, meilisearch: gateway.config }, () => 123, createLogger('search', () => {}));
	try {
		await Promise.all([search.index(note), search.index({ ...note, id: 'second' })]);
		expect(gateway.requests.filter(r => r.method === 'POST')).toHaveLength(2);
		expect(gateway.requests.find(r => r.method === 'POST')).toEqual({ method: 'POST', url: '/indexes/test---notes/documents?primaryKey=id', body: [{ id: 'n', createdAt: 123, userId: 'a', userHost: null, channelId: null, text: 'hello', cw: null, tags: [] }] });
		let closed = false;
		const closing = search.close().then(() => {
			closed = true;
		});
		await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
		held.release(); await closing;
	} finally {
		held.release(); await search.close(); await gateway.close();
	}
});
test('SQL default and SQL providers never contact configured Meili', async () => {
	const gateway = await searchGateway();
	try {
		for (const provider of [undefined, 'sqlLike', 'sqlPgroonga'] as const) {
			const search = createSearchIndex({ fulltextSearch: provider ? { provider } : undefined, meilisearch: gateway.config }, () => 123, createLogger('search', () => {}));
			await search.index(note); await search.unindex(note); await search.close();
		}
		expect(gateway.requests).toEqual([]);
	} finally {
		await gateway.close();
	}
});
test('unindex ignores content and scope; request rejection propagates, settings failure is logged and drains', async () => {
	const logs: string[] = [];
	const gateway = await searchGateway(async request => request.method === 'DELETE' ? undefined : { status: 503, body: { message: 'unavailable', code: 'unavailable', type: 'internal', link: '' } });
	const search = createSearchIndex({ fulltextSearch: { provider: 'meilisearch' }, meilisearch: gateway.config }, () => 123, createLogger('search', line => logs.push(line)));
	try {
		await search.unindex({ id: 'excluded', visibility: 'home' });
		await search.unindex({ id: 'private', visibility: 'followers' });
		await expect(search.index(note)).rejects.toThrow();
		await search.close();
		expect(gateway.requests.filter(r => r.method === 'DELETE').map(r => r.url)).toEqual(['/indexes/test---notes/documents/excluded']);
		expect(logs.join('')).toContain('search-settings.failed');
	} finally {
		await search.close(); await gateway.close();
	}
});

test('index and unindex failures name the operation and target without exposing SDK error messages or credentials', async () => {
	const logs: string[] = [];
	const gateway = await searchGateway(async () => ({ status: 503, body: { message: 'secret-engine-credential', code: 'injected', type: 'internal', link: '' } }));
	const search = createSearchIndex({ fulltextSearch: { provider: 'meilisearch' }, meilisearch: { ...gateway.config, apiKey: 'secret-engine-credential' } }, () => 123, createLogger('search', line => logs.push(line)));
	try {
		await expect(search.index(note)).rejects.toThrow();
		await expect(search.unindex(note)).rejects.toThrow();
		await search.close();
		const events = logs.map(line => JSON.parse(line));
		expect(events).toContainEqual(expect.objectContaining({ event: 'search-index.failed', noteId: 'n' }));
		expect(events).toContainEqual(expect.objectContaining({ event: 'search-unindex.failed', noteId: 'n' }));
		expect(logs.join('')).not.toContain('secret-engine-credential');
	} finally {
		await search.close(); await gateway.close();
	}
});
