/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { metaInitializationLifecyclePath, readPreMetaInitialization } from './meta-initialization-evidence.mjs';
import { inEvidenceValidationScope } from './evidence-validation-scope.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const proof = JSON.parse(read('docs/superpowers/compatibility/meta-initialization/evidence.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = [
	'responsibility:boot-logging-config-telemetry:14',
	'responsibility:boot-logging-config-telemetry:35',
	'responsibility:instance-moderation:02',
];

test('the finite Meta proof inputs still match the measured bytes', () => {
	assert.equal(proof.issue, 574);
	assert.equal(proof.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(proof.runtimeChanged, true);
	assert.equal(proof.upstreamFullServerMeasured, false);
	assert.equal(proof.normalEntrypointEagerMetaProven, true);
	assert.deepEqual(proof.contractRowIds, ids);
	assert.deepEqual(proof.auditRowIds, ids);
	assert(Object.hasOwn(proof.inputs, 'packages/backend-next/test/integration/meta-initialization.test.ts'));
	assert(Object.hasOwn(proof.inputs, 'packages/backend-next/test/processes/meta-initialization.test.ts'));
	assert(Object.hasOwn(proof.inputs, metaInitializationLifecyclePath));
	assert(Object.hasOwn(proof.inputs, 'packages/backend-next/test/unit/lifecycle.test.ts'));
	assert(Object.hasOwn(proof.inputs, 'packages/backend-next/src/platform/database/meta.ts'));
	assert(Object.hasOwn(proof.inputs, 'packages/backend-next/src/platform/meta-cache.ts'));
	for (const [path, digest] of Object.entries(proof.inputs)) assert.equal(sha(read(path)), digest, `Measured Meta proof input drift: ${path}`);
});

test('only the three owned inventory rows are asserted, preserving incomplete management API scope', () => {
	for (const [file, key] of [['contracts.json', 'contracts'], ['audit-items.json', 'items']]) {
		const rows = JSON.parse(read(`docs/superpowers/compatibility/backend-inventory/${file}`))[key];
		for (const id of ids) {
			const row = rows.find(row => row.id === id);
			assert(row, `Missing ${id}`);
			assert.equal(row.status, id === ids[1] ? 'partial' : 'verified');
			assert(row.verification.includes('docs/superpowers/compatibility/meta-initialization/README.md'));
		}
	}
});

test('R1 is retained as historical proof of the former fixture-only boundary', () => {
	const bytes = read('docs/superpowers/compatibility/meta-initialization/evidence-r1.json');
	assert.equal(sha(bytes), proof.previousEvidence.sha256);
	const previous = JSON.parse(bytes);
	assert.equal(previous.runtimeChanged, false);
	assert.equal(previous.normalEntrypointEagerMetaProven, false);
});

test('the lifecycle-only predecessor checks live injected bytes and fresh JSON within one validation scope', () => {
	const previous = JSON.parse(read('docs/superpowers/compatibility/meta-initialization/lifecycle-predecessor.json')).files[metaInitializationLifecyclePath];
	let changed;
	const injected = path => path === changed ? Buffer.from('drift') : read(path);
	inEvidenceValidationScope(() => {
		assert.equal(readPreMetaInitialization(metaInitializationLifecyclePath, injected).toString(), previous);
		changed = metaInitializationLifecyclePath;
		assert.throws(() => readPreMetaInitialization(metaInitializationLifecyclePath, injected), /drift/);
	});
	changed = undefined;
	inEvidenceValidationScope(() => {
		assert.equal(readPreMetaInitialization(metaInitializationLifecyclePath, injected).toString(), previous);
		changed = 'docs/superpowers/compatibility/meta-initialization/r2-inputs.json';
		assert.throws(() => readPreMetaInitialization(metaInitializationLifecyclePath, injected), /drift|seal/);
	});
	assert.equal(readPreMetaInitialization('unrelated', () => Buffer.from('live')).toString(), 'live');
});

test('successful runs retain actual log hashes when logs are available', () => {
	assert.deepEqual(proof.runs.map(run => run.name), ['build-upstream', 'build', 'typecheck', 'unit', 'integration', 'process', 'source-initialization', 'source-cache']);
	for (const run of proof.runs) {
		assert.equal(run.exitCode, 0);
		if (!existsSync(run.log)) continue;
		const log = readFileSync(run.log);
		assert.equal(sha(log), run.logSha256, `Meta proof log drift: ${run.log}`);
		if (run.passed !== undefined) assert(log.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
		if (run.files !== undefined) assert(log.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
	}
});
