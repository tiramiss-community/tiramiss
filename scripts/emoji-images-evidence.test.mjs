/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inEvidenceValidationScope, scopedEvidenceValidation, bindEvidenceCurrentReader } from './evidence-validation-scope.mjs';
import { emojiImagesPredecessorFiles, readPreEmojiImages, validateEmojiImagesEvidence } from './emoji-images-evidence.mjs';
import { readPrePublicEmojis, validatePublicEmojisEvidence } from './public-emojis-evidence.mjs';
import { createPreConnectCheckPackageReader } from './connect-check-package-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/emoji-images/';
const receipt = () => JSON.parse(read(directory + 'current-evidence.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const offline = () => null;

test('emoji image measurements project exactly three changed shared inputs and leave unrelated reads live', () => {
	const previous = validateEmojiImagesEvidence(undefined, read, offline);
	assert.deepEqual(Object.keys(previous), emojiImagesPredecessorFiles);
	const saved = JSON.parse(read(directory + 'predecessor.json'));
	for (const path of emojiImagesPredecessorFiles) {
		assert.equal(sha(readPreEmojiImages(path, read, offline)), saved.files[path].previousSha256);
	}
	assert.equal(sha(createPreConnectCheckPackageReader(read)('pnpm-lock.yaml')), saved.files['pnpm-lock.yaml'].previousSha256);
	assert.equal(readPreEmojiImages('unrelated', () => Buffer.from('current')).toString(), 'current');
	validatePublicEmojisEvidence(undefined, read, offline);
	assert.equal(sha(createPreConnectCheckPackageReader(read)('packages/backend-next/package.json')), '8eae5596313821fb81aeaf01d7e5ae93be9204a48f9323621f23390710746ad8');
});

for (const path of Object.keys(receipt().inputs)) {
	test(`emoji image current input drift is rejected: ${path}`, () => {
		const changed = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
		assert.throws(() => validateEmojiImagesEvidence(undefined, changed, offline), /measured current input drift/);
	});
}

for (const path of emojiImagesPredecessorFiles) {
	test(`same-scope and fresh projected reads reject requested-path drift: ${path}`, () => {
		let changed = false;
		const reader = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
		inEvidenceValidationScope(() => {
			readPreEmojiImages(path, reader, offline);
			changed = true;
			assert.throws(() => readPreEmojiImages(path, reader, offline), /measured current input drift/);
		});
		assert.throws(() => readPreEmojiImages(path, reader, offline), /measured current input drift/);
	});
}

test('both historical terminals refuse current runtime drift before exposing predecessors', () => {
	const path = 'packages/backend-next/src/platform/images/twemoji-badge.ts';
	let changed = false;
	const reader = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
	readPrePublicEmojis('packages/backend-next/src/composition/http-app.ts', reader, offline);
	const packageReader = createPreConnectCheckPackageReader(reader);
	packageReader(emojiImagesPredecessorFiles[0]);
	changed = true;
	assert.throws(() => readPrePublicEmojis('packages/backend-next/src/composition/http-app.ts', reader, offline), /measured current input drift/);
	assert.throws(() => packageReader(emojiImagesPredecessorFiles[0]), /measured current input drift/);
});

test('receipt, predecessor and available log mutations fail closed', () => {
	for (const name of ['current-evidence.json', 'predecessor.json']) {
		assert.throws(() => validateEmojiImagesEvidence(undefined, path => path === directory + name ? Buffer.from('{}') : read(path), offline), /seal/);
	}
	const supplied = receipt();
	supplied.noInputDrift = false;
	assert.throws(() => validateEmojiImagesEvidence(supplied, read, offline), /seal/);
	for (const run of receipt().runs) {
		assert.throws(() => validateEmojiImagesEvidence(undefined, read, path => path === run.log ? Buffer.from('changed') : null), /actual log drift/);
	}
});


test('reader provenance follows only bound ancestry and never substitutes an independent injected reader', () => {
	const path = 'packages/backend-next/src/platform/images/twemoji-badge.ts';
	const independent = file => file === path ? Buffer.concat([read(file), Buffer.from('changed')]) : read(file);
	const bound = bindEvidenceCurrentReader(file => read(file), read);
	inEvidenceValidationScope(() => {
		validateEmojiImagesEvidence(undefined, bound, offline);
		assert.throws(() => validateEmojiImagesEvidence(undefined, independent, offline), /measured current input drift/);
		const run = observer => validateEmojiImagesEvidence(undefined, observer, offline);
		scopedEvidenceValidation(run, undefined, bound, offline, run);
		assert.throws(() => scopedEvidenceValidation(run, undefined, independent, offline, run), /measured current input drift/);
	});
});

test('nested bound views preserve the injected source and returned buffers cannot alter future projections', () => {
	const path = 'packages/backend-next/src/composition/http-app.ts';
	let changed = false;
	const original = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('changed')]) : read(file);
	const view = bindEvidenceCurrentReader(file => read(file), original);
	const nested = bindEvidenceCurrentReader(file => view(file), view);
	const projected = readPreEmojiImages(path, nested, offline);
	const digest = sha(projected);
	projected.fill(0);
	assert.equal(sha(readPreEmojiImages(path, nested, offline)), digest);
	changed = true;
	assert.throws(() => readPreEmojiImages(path, nested, offline), /measured current input drift/);
});


test('cached historical entry keeps successor JSON and optional artifact observations live', () => {
	const product = 'packages/backend-next/src/composition/http-app.ts';
	const json = [directory + 'current-evidence.json', directory + 'predecessor.json', ...Object.keys(receipt().inputs).filter(path => path.endsWith('.json'))];
	for (const path of json) {
		let changed = false;
		const reader = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('changed')]) : read(file);
		inEvidenceValidationScope(() => {
			readPrePublicEmojis(product, reader, offline);
			changed = true;
			assert.throws(() => readPrePublicEmojis(product, reader, offline), /drift|seal/);
		});
	}
	for (const run of receipt().runs) {
		let changed = false;
		const optional = path => path === run.log && changed ? Buffer.from('changed log') : null;
		inEvidenceValidationScope(() => {
			readPrePublicEmojis(product, read, optional);
			changed = true;
			assert.throws(() => readPrePublicEmojis(product, read, optional), /drift/);
		});
	}
});


test('leaf rechecks metadata changed after registration while its first ancestor validation is still running', () => {
	const product = 'packages/backend-next/src/composition/http-app.ts';
	for (const path of [directory + 'current-evidence.json', directory + 'corpus.json']) {
		let changed = false;
		const reader = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('changed')]) : read(file);
		const ancestor = observer => {
			readPreEmojiImages(product, observer, offline);
			changed = true;
			assert.throws(() => readPreEmojiImages(product, observer, offline), /drift|seal/);
		};
		scopedEvidenceValidation(ancestor, undefined, reader, offline, ancestor);
	}
});

test('inventory changes only the five assigned contracts and two audit rows with the immutable product pin', () => {
	const record = JSON.parse(read(directory + 'inventory-evidence.json'));
	assert.equal(record.productRevision, '397be2c9f3dfb30025f3a97c6fc2efa50d51fccc');
	assert.equal(record.contractRowIds.length, 5);
	assert.equal(record.auditRowIds.length, 2);
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
		assert.equal(sha(Buffer.from(JSON.stringify(rows.filter(row => !ids.includes(row.id))))), binding.unrelatedRowsSha256);
	}
});
