/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createHashtagCatalog } from '../../src/modules/hashtag/catalog.js';

function setup() {
	const ports = { list: vi.fn(async () => []), search: vi.fn(async () => []), find: vi.fn(async () => null) };
	return { ports, app: createHashtagCatalog(ports) };
}

test('show uses NFKC and lowercasing, and preserves the missing-tag error', async () => {
	const { app, ports } = setup();
	await expect(app.show({ tag: 'ＡＢＣ' })).rejects.toMatchObject({ code: 'NO_SUCH_HASHTAG', id: '110ee688-193e-4a3a-9ecf-c167b2e6981e' });
	expect(ports.find).toHaveBeenCalledWith('abc');
});
test('search lowercases without compatibility normalization, and keeps signed offsets', async () => {
	const { app, ports } = setup();
	await app.search({ query: 'ＡBC', offset: -1 });
	expect(ports.search).toHaveBeenCalledWith({ query: 'ａbc', limit: 10, offset: -1 });
});
test('list defaults and independent attached filters reach the reader', async () => {
	const { app, ports } = setup();
	await app.list({ sort: '+mentionedUsers', attachedToLocalUserOnly: true });
	expect(ports.list).toHaveBeenCalledWith({ sort: '+mentionedUsers', limit: 10, attachedToUserOnly: false, attachedToLocalUserOnly: true, attachedToRemoteUserOnly: false });
});
test.each([{}, { sort: 'name' }, { sort: '+attachedUsers', limit: 0 }, { sort: '+attachedUsers', limit: 101 }, { sort: '+attachedUsers', attachedToUserOnly: 1 }])('rejects invalid list input before reading: %j', async raw => {
	const { app, ports } = setup();
	await expect(app.list(raw)).rejects.toThrow();
	expect(ports.list).not.toHaveBeenCalled();
});
