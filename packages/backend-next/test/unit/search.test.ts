/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { searchDocument, shouldUnindex } from '../../src/modules/search/public.js';
const note = { id: 'note', userId: 'author', userHost: null as string | null, text: 'hello' as string | null, cw: null as string | null, channelId: null, tags: ['tag'], visibility: 'public' };
test.each(['public', 'home', 'followers', 'specified'])('create/delete search visibility %s', visibility => {
	expect(searchDocument({ ...note, visibility }, 'global', () => 123) !== null).toBe(['public', 'home'].includes(visibility));
	expect(shouldUnindex(visibility)).toBe(['public', 'home'].includes(visibility));
});
test('null content is skipped, CW-only and empty strings are documents, and timestamp comes from ID', () => {
	expect(searchDocument({ ...note, text: null }, 'local', () => 123)).toBeNull();
	for (const content of [{ text: '', cw: null }, { text: null, cw: '' }]) {
		expect(searchDocument({ ...note, ...content }, 'local', () => 123)).toEqual({ id: 'note', userId: 'author', userHost: null, ...content, channelId: null, tags: ['tag'], createdAt: 123 });
	}
});
test.each(['local', 'global', [], ['remote.test'], ['other.test']] as const)('scope %j permits local and exact hosts', scope => {
	expect(searchDocument(note, scope, () => 123)).not.toBeNull();
	expect(searchDocument({ ...note, userHost: 'remote.test' }, scope, () => 123) !== null).toBe(scope === 'global' || Array.isArray(scope) && scope.includes('remote.test'));
	expect(shouldUnindex('public')).toBe(true);
});

const fixed = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/search/observations.json', import.meta.url), 'utf8')) as { observations: { id: string; scope?: 'local' | 'global' | '(default)' | string[]; input?: typeof note; calls?: { method: string; documents?: unknown[] }[] }[] };
test.each(fixed.observations.filter(entry => entry.id.startsWith('eligibility-')))('matches independent fixed-source search document and removal $id', entry => {
	const add = entry.calls!.find(call => call.method === 'addDocuments');
	const scope = entry.scope === '(default)' ? 'local' : entry.scope!;
	expect(searchDocument(entry.input!, scope, () => 1730000000123)).toEqual(add?.documents?.[0] ?? null);
	expect(shouldUnindex(entry.input!.visibility)).toBe(entry.calls!.some(call => call.method === 'deleteDocument'));
});
