/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../docs/superpowers/compatibility/remote-user/', import.meta.url);
const anchors = ['resolve-local', 'resolve-stale-refresh-failure', 'mentions-independent-duplicates',
	'actor-create-Person', 'actor-refresh-profile-failure', 'actor-validation-foreign-shared',
	'actor-create-collection-rate-limited', 'actor-refresh-collection-rate-limited', 'fetch-signed', 'fetch-unsigned',
	'fetch-alternate', 'publication-system', 'publication-local'];
function dataset() {
	assert(existsSync(new URL('observations.json', directory)), 'durable observations must exist');
	return JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8'));
}
function validate(data) {
	assert.equal(data.schemaVersion, 1);
	assert.equal(data.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert(data.exclusions.length > 0);
	assert.equal(new Set(data.cases.map(c => c.id)).size, data.cases.length, 'unique IDs');
	for (const id of anchors) assert(data.cases.some(c => c.id === id), `missing case ${id}`);
	for (const area of ['resolve', 'actor', 'fetch', 'publication']) {
		assert(data.bindings[area]?.length > 0, `missing binding ${area}`);
		assert(data.cases.some(c => c.area === area), `missing area ${area}`);
	}
	for (const c of data.cases) {
		assert(data.bindings[c.area], 'unknown area');
		assert.equal(c.provenance, 'literal-source-method', 'unknown provenance');
		assert(c.methods.length > 0 && c.methods.every(m => data.methods[m]), 'unknown source method');
		assert(c.doubles.length > 0 && c.doubles.every(d => data.doubles[d]), 'undeclared double');
		assert(c.input && c.expected && Array.isArray(c.expected.events));
		assert('result' in c.expected || 'error' in c.expected, 'missing outcome');
	}
	const byId = id => data.cases.find(c => c.id === id).expected;
	for (const [id, size] of [['fetch-signed', 10485760], ['fetch-unsigned', 262144]]) {
		const outcome = byId(id);
		assert(!outcome.error, `${id} must acquire an actor`);
		assert.equal(outcome.events.find(e => e.op === 'fetch').args.size, size, 'transport byte limit');
		if (id === 'fetch-signed') assert.equal(outcome.events.find(e => e.op === 'fetch').args.signatureValid, true);
	}
	assert.deepEqual(byId('resolve-age-86400000').events.map(e => e.op), ['User.find']);
	assert.deepEqual(byId('mentions-independent-duplicates').result, [{ id: 'alice' }, { id: 'bob' }]);
	const failed = data.cases.find(c => c.id === 'actor-refresh-profile-failure').expected;
	assert(failed.error, 'failure outcome required');
	assert.deepEqual(failed.events.filter(e => e.op.endsWith('.update')).map(e => e.op),
		['User.update', 'Key.update', 'Profile.update'], 'refresh write order');
	const stale = data.cases.find(c => c.id === 'resolve-stale-refresh-failure').expected;
	assert.deepEqual(stale.events.map(e => e.op), ['User.find', 'User.update', 'WebFinger', 'User.update', 'Person.update'], 'retained write order');
	assert(stale.state.lastFetchedAt && stale.state.uri, 'retained state required');
	assertForeignShared(data);
	assertRateLimited(data);
	const statusError = data.methods['misc/status-error.ts'];
	assert.equal(statusError?.path, 'packages/backend/src/misc/status-error.ts', 'pinned StatusError source');
	assert.match(statusError.sha256, /^[a-f0-9]{64}$/);
	for (const operation of ['create', 'refresh']) {
		assert(data.cases.find(c => c.id === `actor-${operation}-collection-rate-limited`).methods.includes('misc/status-error.ts'));
	}
}

test('committed projections have consumable outcomes and declared source boundaries', () => validate(dataset()));
test('declared consumer bindings are documented (actual consumers verified by Task 3)', () => {
	const d = dataset();
	const readme = readFileSync(new URL('README.md', directory), 'utf8');
	for (const paths of Object.values(d.bindings)) for (const path of paths) assert(readme.includes(path));
});
for (const [name, mutate] of [
	['missing case', d => { d.cases = d.cases.filter(c => c.id !== 'resolve-local'); }],
	['missing binding', d => { delete d.bindings.actor; }],
	['unknown provenance', d => { d.cases[0].provenance = 'upstream-http'; }],
	['unknown method', d => { d.cases[0].methods = ['invented']; }],
	['undeclared double', d => { d.cases[0].doubles.push('invented'); }],
	['duplicate ID', d => { d.cases.push(d.cases[0]); }],
	['signed limit', d => { d.cases.find(c => c.id === 'fetch-signed').expected.events.find(e => e.op === 'fetch').args.size = 262144; }],
	['foreign shared inbox input', d => { d.cases.find(c => c.id === 'actor-validation-foreign-shared').input.patch.endpoints.sharedInbox = { $undefined: true }; }],
	['429 refresh visibility', d => { d.cases.find(c => c.id === 'actor-refresh-collection-rate-limited').expected.events.find(e => e.op === 'Profile.update').args.patch.followingVisibility = 'private'; }],
	['status error fingerprint', d => { delete d.methods['misc/status-error.ts']; }],
	['write order', d => { d.cases.find(c => c.id === 'actor-refresh-profile-failure').expected.events.reverse(); }],
]) test(`validator rejects ${name}`, () => {
	const d = dataset(); mutate(d); assert.throws(() => validate(d));
});

// These assertions intentionally compare saved inputs and source projections separately.
function assertForeignShared(data) {
	const c = data.cases.find(c => c.id === 'actor-validation-foreign-shared');
	assert.equal(c.input.patch.endpoints.sharedInbox, 'https://other.test/inbox', 'saved input before mutation');
	assert.deepEqual(c.expected.result.endpoints.sharedInbox, { $undefined: true });
	assert(Object.hasOwn(c.expected.result, 'sharedInbox'));
	assert.deepEqual(c.expected.result.sharedInbox, { $undefined: true });
}
function assertRateLimited(data) {
	const cases = data.cases;
	const created = cases.find(c => c.id === 'actor-create-collection-rate-limited');
	const refreshed = cases.find(c => c.id === 'actor-refresh-collection-rate-limited');
	assert.equal(created.input.collectionFail, 429);
	assert.equal(refreshed.input.collectionFail, 429);
	assert.equal(created.expected.events.find(e => e.op === 'Profile.save').args.followingVisibility, 'private');
	assert.deepEqual(refreshed.expected.events.find(e => e.op === 'Profile.update').args.patch.followingVisibility, { $undefined: true });
}
test('foreign shared inbox keeps its original saved input and own undefined outputs', () => assertForeignShared(dataset()));
test('429 collection failure is private on creation and retained on refresh', () => assertRateLimited(dataset()));
