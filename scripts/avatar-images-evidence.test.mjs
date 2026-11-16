/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inEvidenceValidationScope, bindEvidenceCurrentReader, scopedEvidenceValidation } from './evidence-validation-scope.mjs';
import { avatarImagesPredecessorFiles, readPreAvatarImages, validateAvatarImagesEvidence } from './avatar-images-evidence.mjs';
import { validateEmojiImagesEvidence } from './emoji-images-evidence.mjs';
import { readPrePublicEmojis } from './public-emojis-evidence.mjs';
import { createPreConnectCheckPackageReader } from './connect-check-package-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/avatar-images/';
const receipt = () => JSON.parse(read(directory + 'current-evidence.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const offline = () => null;

test('four exact shared preimages preserve the previous emoji-image leaf and package/public-emoji terminals', () => {
	const previous = validateAvatarImagesEvidence(undefined, read, offline);
	const saved = JSON.parse(read(directory + 'predecessor.json'));
	assert.deepEqual(Object.keys(previous), avatarImagesPredecessorFiles);
	for (const path of avatarImagesPredecessorFiles) assert.equal(sha(readPreAvatarImages(path, read, offline)), saved.files[path].previousSha256);
	validateEmojiImagesEvidence(undefined, read, offline);
	readPrePublicEmojis('packages/backend-next/src/composition/http-app.ts', read, offline);
	createPreConnectCheckPackageReader(read)('packages/backend-next/package.json');
	assert.equal(readPreAvatarImages('unrelated', () => Buffer.from('current')).toString(), 'current');
});
for (const path of Object.keys(receipt().inputs)) {
	test(`measured input mutation fails closed: ${path}`, () => {
		const changed = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
		assert.throws(() => validateAvatarImagesEvidence(undefined, changed, offline), /measured current input drift/);
	});
}
for (const path of [...avatarImagesPredecessorFiles, directory + 'current-evidence.json', directory + 'predecessor.json', directory + 'corpus.json']) {
	test(`same-scope and fresh predecessor reads reject requested input/metadata drift: ${path}`, () => {
		let changed = false;
		const reader = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
		inEvidenceValidationScope(() => {
			readPreAvatarImages(avatarImagesPredecessorFiles[0], reader, offline);
			changed = true;
			assert.throws(() => readPreAvatarImages(avatarImagesPredecessorFiles.includes(path) ? path : avatarImagesPredecessorFiles[0], reader, offline), /drift|seal/);
		});
		assert.throws(() => readPreAvatarImages(avatarImagesPredecessorFiles[0], reader, offline), /drift|seal/);
	});
}
test('historical terminals preserve independent injected reader provenance and reject new runtime drift', () => {
	const product = 'packages/backend-next/src/composition/http-app.ts';
	const path = 'packages/backend-next/src/platform/images/identicon.ts';
	const independent = file => file === path ? Buffer.concat([read(file), Buffer.from('changed')]) : read(file);
	const bound = bindEvidenceCurrentReader(file => read(file), read);
	inEvidenceValidationScope(() => {
		validateAvatarImagesEvidence(undefined, bound, offline);
		assert.throws(() => validateAvatarImagesEvidence(undefined, independent, offline), /drift/);
		const ancestor = observer => validateAvatarImagesEvidence(undefined, observer, offline);
		scopedEvidenceValidation(ancestor, undefined, bound, offline, ancestor);
		assert.throws(() => scopedEvidenceValidation(ancestor, undefined, independent, offline, ancestor), /drift/);
	});
	assert.throws(() => readPrePublicEmojis(product, independent, offline), /drift/);
	assert.throws(() => createPreConnectCheckPackageReader(independent)(avatarImagesPredecessorFiles[0]), /drift/);
});
test('receipt objects, raw metadata and available measurement logs cannot be renewed silently', () => {
	for (const name of ['current-evidence.json', 'predecessor.json']) assert.throws(() => validateAvatarImagesEvidence(undefined, path => path === directory + name ? Buffer.from('{}') : read(path), offline), /seal/);
	const value = receipt(); value.noInputDrift = false;
	assert.throws(() => validateAvatarImagesEvidence(value, read, offline), /seal/);
	for (const run of receipt().runs) assert.throws(() => validateAvatarImagesEvidence(undefined, read, path => path === run.log ? Buffer.from('changed') : null), /actual log drift/);
});
test('historical ancestor detects successor metadata changes even while its first validation is running', () => {
	const product = 'packages/backend-next/src/composition/http-app.ts';
	for (const path of [directory + 'current-evidence.json', directory + 'predecessor.json', directory + 'corpus.json']) {
		let changed = false;
		const reader = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('changed')]) : read(file);
		const ancestor = observer => {
			readPrePublicEmojis(product, observer, offline);
			changed = true;
			assert.throws(() => readPrePublicEmojis(product, observer, offline), /drift|seal/);
		};
		scopedEvidenceValidation(ancestor, undefined, reader, offline, ancestor);
	}
});
test('the finite inventory attests only eight assigned contracts and five audit rows', () => {
	const record = JSON.parse(read(directory + 'inventory-evidence.json'));
	assert.equal(record.contractRowIds.length, 8);
	assert.equal(record.auditRowIds.length, 5);
	for (const [path, binding] of Object.entries(record.files)) {
		const value = JSON.parse(read(path));
		const rows = value.contracts ?? value.items;
		const ids = path.endsWith('/contracts.json') ? record.contractRowIds : record.auditRowIds;
		assert.deepEqual(Object.keys(binding.changedRows), ids);
		for (const id of ids) {
			const row = rows.find(item => item.id === id);
			assert.equal(row.status, 'verified');
			assert.equal(row.evidenceRevision, record.productRevision);
			assert.equal(sha(Buffer.from(JSON.stringify(row))), binding.changedRows[id].currentSha256);
		}
	}
});
