/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectIdCodecInput } from './id-codec-predecessor.mjs';
import { validateDriveFolderPubsubSuccessor } from './drive-folder-pubsub-evidence.mjs';
import { validateDriveFoldersSuccessor } from './drive-folders-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const file = 'packages/backend-next/src/platform/id-codec.ts';
const record = JSON.parse(read('docs/superpowers/compatibility/id-codec/compatibility-predecessor.json'));

test('only the measured ID codec input projects to its sealed predecessor; later drift remains visible', () => {
	assert.deepEqual(Object.keys(record.files), [file]);
	const actual = read(file);
	assert.equal(sha(actual), record.files[file].currentSha256);
	assert.equal(sha(projectIdCodecInput(file, actual)), record.files[file].previousSha256);
	const drift = Buffer.concat([actual, Buffer.from('\n')]);
	assert.equal(projectIdCodecInput(file, drift), drift);
	assert.equal(projectIdCodecInput('unrelated', actual), actual);
});

test('historical folder receipts remain sealed and reject changed ID bytes through the full reader chain', () => {
	for (const validate of [validateDriveFolderPubsubSuccessor, validateDriveFoldersSuccessor]) {
		assert.doesNotThrow(() => validate(undefined, read, () => null));
		assert.throws(() => validate(undefined, path => path === file ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path), () => null), /measured current input drift/);
	}
});


test('folder input reads reject ID drift after the pubsub input validation has completed', () => {
	const directory = 'docs/superpowers/compatibility/drive-folders/';
	let pubsubInputsValidated = false;
	let folderInputs = false;
	const reader = path => {
		if (path === directory + 'pubsub-fix-predecessor.json') pubsubInputsValidated = true;
		if (pubsubInputsValidated && path === directory + 'current-evidence.json') folderInputs = true;
		return folderInputs && path === file ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
	};
	assert.throws(() => validateDriveFoldersSuccessor(undefined, reader, () => null), error => {
		assert(pubsubInputsValidated && folderInputs, 'pubsub inputs pass before the folder input changes');
		assert.equal(error.message.split('\n')[0], `measured current input drift: ${file}`);
		assert(!error.message.includes('pubsub successor'));
		return true;
	});
});
