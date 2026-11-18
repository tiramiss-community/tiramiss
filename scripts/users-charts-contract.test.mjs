/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateUsersChartsEvidence } from './users-charts-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));

test('users chart actual input and log receipt validates with and without host logs', () => {
	assert.equal(validateUsersChartsEvidence().measurement, 'R5');
	assert.equal(validateUsersChartsEvidence(read, () => null).sourceCases.reads, 24);
});

test('every users measured current input rejects new unmeasured bytes offline', () => {
	const receipt = validateUsersChartsEvidence(read, () => null);
	for (const path of Object.keys(receipt.inputs)) {
		assert.throws(() => validateUsersChartsEvidence(file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), () => null), /users chart current input drift/);
	}
});

test('users chart receipt and available actual log corruption reject', () => {
	assert.throws(() => validateUsersChartsEvidence(path => path.endsWith('/current-evidence.json') ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path), () => null), /users chart evidence seal/);
	assert.throws(() => validateUsersChartsEvidence(read, () => Buffer.from('forged actual log')), /users chart actual log drift/);
});
