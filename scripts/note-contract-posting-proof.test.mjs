/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const artifact = new URL('docs/superpowers/compatibility/note/n7/posting-proof-272.json', root);
test('finite #272 posting proof artifact exists', () => {
	assert.ok(existsSync(artifact), 'missing current posting-proof-272.json artifact');
});

const read = file => readFileSync(new URL(file, root), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const historicalSource = (commit, file) => execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const load = () => JSON.parse(readFileSync(artifact, 'utf8'));

test('current finite posting proof passes integrity checks', () => validate(load()));
for (const [name, mutate, error] of [
	['missing ID', d => d.assignments.pop(), /assignment identities/],
	['duplicate ID', d => d.assignments.push(d.assignments[0]), /assignment identities/],
	['missing fixture key', d => d.evidenceBindings.create.dataset.caseIds.push('C1-does-not-exist'), /fixture case/],
	['wrong parameter binding', d => d.evidenceBindings.create.dataset.caseIds.pop(), /reviewed evidence/],
	['wrong declaration', d => d.evidenceBindings.create.testTitle = 'invented title', /declaration/],
	['source hash drift', d => d.evidenceBindings.create.sourceSha256 = '0'.repeat(64), /source hash/],
	['false provenance', d => d.evidenceBindings.render.provenance = 'upstream-http', /reviewed evidence/],
	['false full-server scope', d => d.evidenceBindings.render.fullServerParity = true, /full-server/],
	['posting completion', d => d.postingComplete = true, /postingComplete/],
	['create promotion', d => d.notesCreateStatus = 'verified', /notesCreateStatus/],
	['inventory promotion', d => d.assignments[0].inventoryStatus = 'verified', /inventory status/],
	['audit promotion', d => d.assignments[0].audit.A = 'verified', /audit classification/],
	['historical rebinding', d => d.historicalSourceCommit = d.runtimeBaseline, /historical source/],
	['D7 removal', d => d.protectedScope.d7.maxDepth = 65, /protected scope/],
	['PG approval removal', d => d.protectedScope.pgNotificationPersistenceApproved = false, /protected scope/],
	['parent closure', d => d.protectedScope.parents['176'] = 'CLOSED', /protected scope/],
	['unproved promotion', d => d.assignments.find(r => r.id === 'responsibility:packers:08').subcontracts[0].disposition = 'scoped-runtime-assertion', /unproved cannot|reviewed assignments|assert.ok/],
	['runtime input drift', d => d.sourceInputs['packages/backend-next/src/modules/note/render-note.ts'] = '0'.repeat(64), /input hash/],
]) {
	test(`rejects ${name}`, () => {
		const value = load();
		mutate(value);
		assert.throws(() => validate(value), error);
	});
}

test('rejects removal of an actual fixture observation', () => {
	assert.throws(() => validate(load(), file => {
		if (file === 'docs/superpowers/compatibility/note/rate-observations.json') {
			const fixture = JSON.parse(read(file));
			delete fixture['C2-rate-db-delta'];
			return JSON.stringify(fixture);
		}
		return read(file);
	}), /fixture case C2-rate-db-delta/);
});

test('rejects actual declaration drift in the consumer', () => {
	assert.throws(() => validate(load(), file => read(file).replace(
		'%s matches fixed upstream HTTP, saved Note and immediate show', 'renamed unreviewed declaration',
	)), /declaration/);
});

test('rejects actual source drift with an unchanged declaration', () => {
	assert.throws(() => validate(load(), file => file.endsWith('/integration/note-create.test.ts')
		? read(file) + '\n// unreviewed consumer change\n' : read(file)), /source hash/);
});

test('rejects false direct-runtime provenance for a source-only deletion case', () => {
	const value = load();
	value.deleteSourceCases.find(x => x.id === 'stream-throws').disposition = 'direct-projected-comparison';
	assert.throws(() => validate(value), /reviewed deleteSourceCases/);
});

// Integrity checks preserve reviewed finite claims; they are not behavior/parity tests.
function validate(value, readInput = read) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.runtimeBaseline, 'b4f28f6ceef458575f203c19d4ede37d7311468c');
	assert.equal(value.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(value.historicalSourceCommit, 'f556283b8536592e77f0d76b046d0cb300fa70de', 'historical source');
	assert.equal(value.postingComplete, false, 'postingComplete');
	assert.equal(value.notesCreateStatus, 'partial', 'notesCreateStatus');
	assert.deepEqual(value.protectedScope, {
		d7: { maxDepth: 64, maxNotes: 256 }, pgNotificationPersistenceApproved: true,
		parents: { 176: 'OPEN', 127: 'OPEN' }, residualIssues: [277, 322],
		wholeServiceParity: false, strongCreateDeleteOrdering: false,
	}, 'protected scope');
	const catalogue = JSON.parse(readInput('docs/backend-next/backlog.json')).units.find(x => x.key === '176-posting-proof');
	const contracts = JSON.parse(readInput('docs/superpowers/compatibility/backend-inventory/contracts.json')).contracts;
	const audit = JSON.parse(readInput('docs/superpowers/compatibility/backend-inventory/audit-items.json')).items;
	assert.equal(value.assignments.length, 62, 'assignment identities');
	assert.deepEqual(value.assignments.map(x => x.id).sort(), [...catalogue.contract_ids].sort(), 'assignment identities');
	assert.deepEqual(value.assignments.filter(x => x.audit).map(x => x.id).sort(), [...catalogue.audit_ids].sort(), 'audit identities');
	assert.equal(catalogue.audit_ids.length, 59);
	for (const row of value.assignments) {
		const original = contracts.find(x => x.id === row.id);
		assert.equal(row.inventoryStatus, original.status, `inventory status ${row.id}`);
		assert.equal(row.kind, original.kind);
		assert.equal(row.upstreamSource, original.source);
		if (row.audit) {
			const item = audit.find(x => x.id === row.id);
			assert.deepEqual(row.audit, item.audit, 'audit classification');
			assert.equal(row.auditStatus, item.status, 'audit status');
		}
		assert.ok(row.subcontracts.length, 'explicit subcontracts');
		for (const sub of row.subcontracts) {
			assert.ok(sub.scope.length > 15 && sub.remaining.length > 15 && sub.owners.length, 'scoped residual');
			assert.ok(['scoped-runtime-assertion', 'approved-difference', 'reviewed-but-unproved', 'direct-recorded-fixture-comparison'].includes(sub.disposition));
			if (sub.disposition === 'reviewed-but-unproved') {
				assert.deepEqual(sub.evidence, [], 'unproved cannot claim assertions');
			} else {
				assert.ok(sub.evidence.length);
			}
			for (const id of sub.evidence) assert.ok(value.evidenceBindings[id], `unknown evidence ${id}`);
		}
	}
	for (const ref of Object.values(value.evidenceBindings)) {
		assert.equal(ref.fullServerParity, false, 'full-server parity forbidden');
		const source = ref.sourceCommit ? historicalSource(ref.sourceCommit, ref.file) : readInput(ref.file);
		assert.ok(source.includes(ref.declaration ?? `('${ref.testTitle}',`), `declaration ${ref.testTitle}`);
		assert.equal(digest(source), ref.sourceSha256, `source hash ${ref.file}`);
		assert.ok(value.measurements[ref.measurement], 'known dated measurement');
		assert.ok(ref.assertions.length > 20 && ref.limitations.length > 20);
		if (ref.dataset?.file.endsWith('.json')) {
			const fixture = JSON.parse(readInput(ref.dataset.file));
			const collection = ref.dataset.collection ? fixture[ref.dataset.collection] : fixture;
			assert.equal(new Set(ref.dataset.caseIds).size, ref.dataset.caseIds.length, 'unique fixture cases');
			for (const id of ref.dataset.caseIds) {
				assert.ok(Array.isArray(collection) ? collection.some(x => x.id === id) : Object.hasOwn(collection, id), `fixture case ${id}`);
			}
			if (ref.dataset.sourceExpression) assert.ok(source.includes(ref.dataset.sourceExpression), 'parameter expression');
		}
	}
	for (const group of value.groups) {
		for (const id of group.evidence) assert.ok(value.evidenceBindings[id], 'group evidence');
		for (const obs of group.observations ?? []) assert.ok(Object.hasOwn(JSON.parse(readInput(obs.file)), obs.key), 'observation key');
	}
	assert.deepEqual(value.groups.map(x => x.id), ['C1','C2','C3','C4','C5','C6','C7','C8','C9','C10','F1','F2','F3','F4','F5','F6','F7','F8']);
	for (const [file, hash] of Object.entries(value.sourceInputs)) assert.equal(digest(readInput(file)), hash, `input hash ${file}`);
	for (const [file, hash] of Object.entries(value.upstreamSourceHashes)) assert.equal(digest(historicalSource(value.upstreamCommit, file)), hash, `upstream source hash ${file}`);
	// Seals require a deliberate review when a declaration's meaning, parameters,
	// provenance or ID mapping changes; a valid key/title alone is insufficient.
	for (const [key, seal] of Object.entries(reviewed)) assert.equal(digest(JSON.stringify(value[key])), seal, `reviewed ${key === 'evidenceBindings' ? 'evidence' : key}`);
}

const reviewed = {
  "evidenceBindings": "0eb55065ba2330357b281846eded8d7f85c242ef78d40bdbab6886979cfbc424",
  "assignments": "0d2f830777d834352fd5b5706b4d50623aa7f687e51079ad498dfe1b1d4d5768",
  "groups": "1c4d4c9f782d27db33123ebf3a6c2345d1778004b8644c1e71dd3ab5279ed6ca",
  "deleteSourceCases": "6f96b4d8be861c69830e67c4af728f0e1de7899d97e381912eef102a921dde11",
  "measurements": "72e823fda9a60bd801cf1afbeeffadaaddf08126e5819f2d0fbb87f2bab8a6a9",
  "sourceInputs": "fef97944b14eff89c29eecad9a1a92598692c571f252e0b216e30fddfbd9e49a",
  "upstreamSourceHashes": "cb653d703b2bd207f5e1a1114712ccef8593dc70aac72b1d70920929eaa10ece",
  "limitations": "50fab1951d62d94a0dec4e500cc899033ada24121f96e194b8fd67668efbab78"
};
