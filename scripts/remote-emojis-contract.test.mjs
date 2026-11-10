/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { remoteEmojiDigest, validateRemoteEmojiEvidence } from './remote-emojis-evidence.mjs';
const directory = new URL('../docs/superpowers/compatibility/remote-user/', import.meta.url);
const receipt = () => JSON.parse(readFileSync(new URL('remote-emojis-runtime-evidence.json', directory), 'utf8'));

test('real source emoji observations retain partial writes and distinct create/refresh failure positions', () => {
	const source = JSON.parse(readFileSync(new URL('remote-emojis-observations.json', directory), 'utf8'));
	assert.equal(source.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(source.upstreamHttpMeasured, false);
	assert(source.methods['ApNoteService.extractEmojis']);
	assert(source.methods['miRepository.insertOne']);
	for (const name of ['createPerson', 'updatePerson']) { assert(source.methods['ApPersonService.' + name]); }
	const byId = id => source.cases.find(c => c.id === id).expected;
	assert.equal(byId('create-bad-url').rows.length, 0);
	assert.equal(byId('refresh-bad-url').rows.length, 1);
	assert.deepEqual(byId('create-canonical').result.emojis, ['retained']);
	assert.equal(byId('duplicate-new').rows.length, 1);
	assert(byId('duplicate-new').error);
	assert.equal(byId('early-rejection').events.find(e => e.op === 'response').args.rows.length, 0);
	assert.equal(byId('early-rejection').rows[0].name, 'wave');
});

test('emoji evidence binds measured current files and keeps old receipts intact', () => validateRemoteEmojiEvidence(receipt()));
for (const [name, corrupt] of [
	['premature completion', value => { value.postingComplete = true; }],
	['missing runtime', value => { delete value.measurements.process; }],
	['failed run', value => { value.measurements.integration.outcome = 'FAIL'; }],
	['invented current byte', value => { Object.values(value.files)[0].sha256 = '0'.repeat(64); }],
]) {
	test(`emoji evidence rejects ${name}`, () => {
		const value = receipt(); corrupt(value);
		assert.throws(() => validateRemoteEmojiEvidence(value));
	});
}
test('emoji identity projection rejects an unmeasured predecessor', () => {
	assert.throws(() => remoteEmojiDigest('packages/backend-next/src/composition/remote-users.ts', '0'.repeat(64)));
});
