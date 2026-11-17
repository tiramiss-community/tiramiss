/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectUserMemoInput } from './notes-pagination-evidence.mjs';
import { projectUserMemoEntityInput } from './package-imports-evidence.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const product = 'packages/backend-next/src/composition/http-app.ts';
const shared = 'packages/backend-next/test/unit/composition/http-app.test.ts';

for (const [path, digest] of [[product, 'e8851b4ec5bba14758c315e98368105051463cb7cba8d26b3c18ad332ff381cc'], [shared, 'a2f030dbfecfa3644a09d1d1aca81a8693ffec7dbad1bc3ceac9894fb46be5eb']]) {
	test(`memo additions preserve the previous measured composition: ${path}`, () => {
		const expected = path === shared && hash(read(path)) === 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2'
			? 'fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e' : digest;
		assert.equal(hash(projectUserMemoInput(path, read(path))), expected);
		assert.throws(() => projectUserMemoInput(path, Buffer.concat([read(path), Buffer.from('\n')])), /measured current input drift/);
		// Every invocation inspects its actual bytes, including after a valid read.
		assert.throws(() => projectUserMemoInput(path, Buffer.from(read(path).toString().replace('createBackendHttpApp', 'changedBackendHttpApp'))), /measured current input drift/);
	});
}

test('the exact synthetic memo plus poll composition projects only memo additions to the known poll-only input', () => {
	const current = read(shared).toString();
	const combined = hash(current) === 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2' ? current : current
		.replace("'/api/notes',", "'/api/notes/polls/recommendation', '/api/notes',")
		.replace('for (const path of [', "for (const path of ['notes/polls/recommendation', ");
	assert.equal(hash(combined), 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2');
	const pollOnly = projectUserMemoInput(shared, Buffer.from(combined));
	assert.equal(hash(pollOnly), 'fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e');
	assert(pollOnly.toString().includes("'notes/polls/recommendation'"));
	assert(!pollOnly.toString().includes('users/update-memo'));
	assert.throws(() => projectUserMemoInput(shared, Buffer.from(combined.replace('recommendation', 'forged'))), /measured current input drift/);
});

test('memo predecessor leaves unrelated inputs untouched', () => {
	const bytes = Buffer.from('unrelated');
	assert.equal(projectUserMemoInput('unrelated.ts', bytes), bytes);
});

for (const [path, previous] of [
	['packages/backend-upstream/.managed-files.json', 'e2a6859ffa1f6e0ac16db2c92b5b6a0a0a451d197ebd5672fbc3aff21250781a'],
	['packages/backend-upstream/exports/entities.ts', 'a3ba9f949469c6d730cbdcdd070994b38dbc55980075397ffc6df4eccc6d03dc'],
	['packages/backend-upstream/upstream-sync.json', '321ffe253df336975cc763aacb04f8f5a2286c1d4e85a76285b74b58373429dd'],
	['packages/backend-next/test/package-imports.test.ts', '6cbf1b616b51d139298dc85350137a10c430a89205467cf454ba8b101de68d90'],
]) {
	test(`Entity sync preserves only its exact historic input: ${path}`, () => {
		assert.equal(hash(projectUserMemoEntityInput(path, read(path))), previous);
		assert.throws(() => projectUserMemoEntityInput(path, Buffer.concat([read(path), Buffer.from('\n')])), /package import measured input/);
	});
}
