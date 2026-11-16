/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inEvidenceValidationScope } from './evidence-validation-scope.mjs';
import { publicEmojisPredecessorFiles, readPrePublicEmojis, validatePublicEmojisEvidence } from './public-emojis-evidence.mjs';
import { readPrePublicDocuments } from './public-documents-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/public-emojis/';
const receipt = () => JSON.parse(read(directory + 'current-evidence.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('public source observations bind fixed source blobs, all HTTP cases and explicit prefetch scope', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const observed = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observed.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observed.corpusSha256, sha(read(directory + 'corpus.json')));
	assert.equal(observed.source['server/api/endpoints/emoji.ts'], 'a2f587f08fa96873e59145880abb21484ba7681f84a55fbe24dd0bcd1b1329dc');
	assert.equal(observed.source['server/api/endpoints/emojis.ts'], 'f5de373c2c36a81150aed43055752e0ac601de21ca621f6530f07cff2cbefad8');
	assert.equal(observed.source['core/entities/EmojiEntityService.ts'], '16c340773963675b5706d984ff1608db44a8d9226199a0da605ea3be0e875392');
	assert.deepEqual(observed.cases.map(item => item.id), corpus.cases.map(item => item.id));
	assert.equal(observed.cases.length, 16);
	assert.equal(observed.prefetch.length, 2);
	const source = read('packages/backend-next/test/integration/public-emojis.test.ts').toString();
	assert(source.includes('observations.cases'));
	assert(source.includes('corpus.cases.find'));
	assert(source.includes('observations.prefetch[1]'));
});

test('finite current gate restores only the four exact shared predecessors with host logs absent', () => {
	const before = validatePublicEmojisEvidence(undefined, read, () => null);
	const saved = JSON.parse(read(directory + 'predecessor.json'));
	assert.deepEqual(Object.keys(before), publicEmojisPredecessorFiles);
	for (const path of publicEmojisPredecessorFiles) {
		assert.equal(sha(read(path)), saved.files[path].currentSha256);
		assert.equal(sha(readPrePublicEmojis(path, read, () => null)), saved.files[path].previousSha256);
	}
	assert.equal(readPrePublicEmojis('unrelated', () => Buffer.from('live')).toString(), 'live');
});

for (const path of Object.keys(receipt().inputs)) {
	test(`every current input is checked by direct and next historical public invocation: ${path}`, () => {
		const drift = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
		assert.throws(() => validatePublicEmojisEvidence(undefined, drift, () => null), /measured current input drift/);
		assert.throws(() => readPrePublicDocuments(publicEmojisPredecessorFiles[0], drift, () => null), /measured current input drift/);
	});
}

test('receipt/predecessor mutation, supplied historical bytes and present log drift reject', () => {
	for (const name of ['current-evidence.json', 'predecessor.json']) {
		assert.throws(() => validatePublicEmojisEvidence(undefined, path => path === directory + name ? Buffer.from('{}') : read(path), () => null), /seal/);
	}
	const forged = receipt();
	forged.noInputDrift = false;
	assert.throws(() => validatePublicEmojisEvidence(forged, read, () => null), /seal/);
	for (const run of receipt().runs) {
		assert.throws(() => validatePublicEmojisEvidence(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
	}
	const before = validatePublicEmojisEvidence(undefined, read, () => null);
	assert.throws(() => validatePublicEmojisEvidence(undefined, path => Object.hasOwn(before, path) ? Buffer.from(before[path]) : read(path), () => null), /measured current input drift/);
});

test('same-scope and later public invocations recheck requested live bytes', () => {
	const path = publicEmojisPredecessorFiles[0];
	let changed = false;
	const reader = file => file === path && changed ? Buffer.from('changed') : read(file);
	const offline = () => null;
	inEvidenceValidationScope(() => {
		readPrePublicEmojis(path, reader, offline);
		changed = true;
		assert.throws(() => readPrePublicEmojis(path, reader, offline), /measured current input drift/);
	});
	assert.throws(() => readPrePublicEmojis(path, reader, offline), /measured current input drift/);
});
