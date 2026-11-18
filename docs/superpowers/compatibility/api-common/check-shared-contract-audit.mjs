/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const evidence = JSON.parse(readFileSync(new URL('shared-contract-audit.json', import.meta.url), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const read = (revision, path) => git('show', `${revision}:${path}`);
const upstream = '8e07cf085adf7009583d234a208e30436f020e26';
const implementation = '6af8cd5baab289e684266cde7c3955129320c8c3';
const typesPath = 'packages/backend/src/types.ts';
const types = read(upstream, typesPath);
assert.equal(evidence.upstreamCommit, upstream);
assert.equal(evidence.implementationCommit, implementation);
assert.deepEqual(evidence.inventoryIds, ['responsibility:misc-utils:28', 'responsibility:misc-utils:39']);
assert.deepEqual(evidence.sources.map(row => row.path), [
	'packages/backend/src/misc/safe-for-sql.ts',
	'packages/backend/src/misc/sql-like-escape.ts',
	'packages/backend/src/misc/sql-string-escape.ts', typesPath,
]);

const expectedDeclarations = [];
for (const { path, sha256 } of evidence.sources) {
	const text = read(upstream, path);
	assert.equal(createHash('sha256').update(text).digest('hex'), sha256, path);
	for (const match of text.matchAll(/^export (const|type|function) (\w+)/gm)) {
		expectedDeclarations.push({ name: match[2], kind: match[1], source: path, line: text.slice(0, match.index).split('\n').length });
	}
}
assert.deepEqual(evidence.declarations.map(({ name, kind, source, line }) => ({ name, kind, source, line })), expectedDeclarations);
assert.equal(expectedDeclarations.length, 18);
const checkOwners = owners => assert(owners.length > 0 && owners.every(value => Number.isInteger(value) && value > 0), 'missing owner');
const declaration = name => evidence.declarations.find(row => row.name === name);
const units = JSON.parse(read(implementation, 'docs/backend-next/backlog.json')).units;
const checkCatalogOwner = (id, owners) => {
	const candidates = units.filter(unit => unit.contract_ids.includes(id)).map(unit => unit.actualIssueNumber);
	assert(candidates.length > 0 && candidates.some(issue => owners.includes(issue)), `${id} owner differs from backlog`);
};
for (const row of evidence.declarations) {
	checkOwners(row.ownerIssues);
	assert(row.remainingComparison.length > 0);
	assert.equal(row.inventoryId, `responsibility:misc-utils:${row.source === typesPath ? 39 : 28}`);
	const internalReferences = read(upstream, row.source).split('\n').flatMap((text, index) =>
		new RegExp(`\\b${row.name}\\b`).test(text) && index + 1 !== row.line ? [{ line: index + 1, text: text.trim() }] : []);
	assert.deepEqual(row.internalReferences, internalReferences, `${row.name} same-file references`);
	const refs = new Map();
	for (const line of git('grep', '-n', '-w', '-e', row.name, upstream, '--', 'packages/backend/src').trimEnd().split('\n')) {
		const [, path, number, text] = line.match(/^[^:]+:([^:]+):(\d+):(.*)$/);
		if (path === row.source) continue;
		if (!refs.has(path)) refs.set(path, []);
		refs.get(path).push({ line: Number(number), text: text.trim() });
	}
	assert.deepEqual(row.references.map(({ path, matches }) => ({ path, matches })), [...refs].map(([path, matches]) => ({ path, matches })), row.name);
	row.references.forEach(ref => {
		checkOwners(ref.ownerIssues);
		if (ref.path.includes('/server/api/endpoints/')) {
			checkCatalogOwner(`api:${ref.path.split('/server/api/endpoints/')[1].replace(/\.ts$/, '')}`, ref.ownerIssues);
		}
	});
	for (const path of [...row.implementation, ...row.existingFixtures]) {
		git('cat-file', '-e', `${implementation}:${path}`);
	}
	if (row.kind === 'const') {
		const suffix = types.slice(types.indexOf(`export const ${row.name} `)).split('] as const')[0];
		const values = [...suffix.matchAll(/'([^']*)'/g)].map(match => match[1]);
		if (row.name === 'groupedNotificationTypes') values.unshift(...declaration('notificationTypes').values);
		if (/\bnull\b/.test(suffix)) values.push(null);
		assert.deepEqual(row.values, values, row.name);
	}
}
assert.equal(declaration('mutedNoteReasons').references.length, 0);
assert.equal(declaration('userImportableEntities').references.length, 0);
const moderationTypes = declaration('moderationLogTypes').values;
const payload = types.split('export type ModerationLogPayloads = {')[1].split('\n};')[0];
assert.deepEqual([...payload.matchAll(/^\t(\w+):/gm)].map(match => match[1]), moderationTypes);
assert.deepEqual(evidence.moderationProducers.map(row => row.type), moderationTypes);
for (const row of evidence.moderationProducers) {
	const expected = git('grep', '-n', '-F', `'${row.type}'`, upstream, '--', 'packages/backend/src').trimEnd().split('\n')
		.filter(line => new RegExp(`\\.log\\([^\\n]*['"]${row.type}['"]`).test(line))
		.map(line => {
			const [, path, number] = line.match(/^[^:]+:([^:]+):(\d+):/);
			return { path, line: Number(number) };
		});
	assert(expected.length > 0, row.type);
	assert.deepEqual(row.producers.map(({ path, line }) => ({ path, line })), expected, row.type);
	row.producers.forEach(ref => { checkOwners(ref.ownerIssues); assert(ref.ownerIssues.includes(194)); });
}
for (const [name, rows] of [['userExportableEntities', evidence.exportValues], ['userImportableEntities', evidence.importValues]]) {
	assert.deepEqual(rows.map(row => row.value), declaration(name).values);
	for (const row of rows) {
		checkOwners(row.ownerIssues);
		assert(row.ownerIssues.includes(199));
		checkCatalogOwner(`processor:${row.processor.split('/').at(-1).replace('ProcessorService.ts', '')}`, row.ownerIssues);
		const text = read(upstream, row.processor);
		const lines = text.split('\n').flatMap((line, index) => line.includes(`exportedEntity: '${row.value}'`) ? [index + 1] : []);
		assert.deepEqual(row.notificationLines, lines);
		if (name === 'userExportableEntities') assert(lines.length > 0, row.value);
	}
}
console.log(`PASS: ${expectedDeclarations.length} declarations, ${moderationTypes.length} moderation types / ${evidence.moderationProducers.reduce((sum, row) => sum + row.producers.length, 0)} producer sites, 9 export / 6 import values; fixed source and fixture paths match.`);
