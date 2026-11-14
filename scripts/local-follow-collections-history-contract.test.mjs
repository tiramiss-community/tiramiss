/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadFollowCollectionsR2History } from './local-follow-collections-history.mjs';

test('history fixture supplies original validator and all55 verified frozen inputs', () => {
	const history = loadFollowCollectionsR2History();
	const r2 = JSON.parse(readFileSync(new URL('../docs/superpowers/compatibility/remote-user/local-follow-collections-current-evidence.json', import.meta.url)));
	assert.equal(Object.keys(r2.frozenInputSha256).length, 55);
	assert(history.validator.includes('validateLocalFollowCollectionsEvidence'));
	for (const path of Object.keys(r2.frozenInputSha256)) assert(history.read(path).length > 0);
});

test('missing history fixture fails instead of inventing historical bytes', () => {
	assert.throws(() => loadFollowCollectionsR2History(() => null), /missing history fixture/);
});

test('corrupt history fixture bytes fail before decoding or historical validation', () => {
	const bytes = readFileSync(new URL('../docs/superpowers/compatibility/remote-user/local-follow-collections-r2-history-fixture.json', import.meta.url));
	assert.throws(() => loadFollowCollectionsR2History(() => Buffer.concat([bytes, Buffer.from(' ')])), /history fixture bytes/);
	assert.throws(() => loadFollowCollectionsR2History(() => Buffer.from('{}')), /history fixture bytes/);
});
