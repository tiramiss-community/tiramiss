/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const runtime = () => JSON.parse(readFileSync(new URL('runtime-evidence.json', directory), 'utf8'));
const implementationCommit = '33e67182e3dea5a39bd2b7c251ba9ee9ec4e0f45';
const selections = {
	resolve: c => c.id.startsWith('resolve-'),
	mentions: c => c.id === 'mentions-independent-duplicates',
	webfinger: c => c.id.startsWith('webfinger-'),
	'actor-plans': c => c.area === 'actor' && c.input.operation !== 'validate' && !c.input.fail && !c.input.duplicate && !c.input.deleted,
	'actor-refresh': c => c.area === 'actor' && c.input.operation === 'refresh',
	'actor-create-failure': c => c.id === 'actor-create-profile-failure',
	'actor-duplicates': c => ['actor-create-duplicate-uri', 'actor-create-duplicate-missing'].includes(c.id),
	'actor-validation': c => c.area === 'actor' && c.input.operation === 'validate',
	fetch: c => c.area === 'fetch',
	'publication-render': c => ['publication-local', 'publication-system', 'publication-bot', 'publication-deleted'].includes(c.id),
	'publication-adapter': c => c.area === 'publication',
	'publication-http': c => c.area === 'publication',
};
const same = (a, b, message) => assert.deepEqual([...a].sort(), [...b].sort(), message);

// These finite bindings were checked against the actual assertions and parent run JSON.
// Source/title/hash checks detect later drift; they are not a semantic parity oracle.
function validateRuntime(value, data = dataset(), sourceRead = read) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.implementationCommit, implementationCommit, 'reviewed implementation commit');
	assert.equal(value.upstreamCommit, data.upstreamCommit, 'fixed upstream');
	assert.equal(value.observationsSha256, sha(readFileSync(new URL('observations.json', directory))), 'actual source fixture drift');
	assert.equal(value.sourceCaseCount, 95);
	assert.equal(data.cases.length, 95);
	assert.equal(value.upstreamHttpMeasured, false, 'no upstream full HTTP measurement');
	assert.deepEqual(value.environment, { node: '24.20.0', pnpm: '12.9.1', requestedNode: '26.4.0', node26Verified: false }, 'measured environment');
	assert(read(value.results).length > 100, 'durable measured results');
	for (const [id, expected] of Object.entries({ 'closest-units': [254, 5], integration: [61, 2], process: [3, 1], 'closest-units-foundation-253': [257, 5] })) {
		const measured = value.measurements[id];
		assert(measured, `missing measurement ${id}`);
		assert.equal(measured.provenance, 'new-runtime');
		assert.equal(measured.implementationCommit, implementationCommit);
		assert.equal(measured.outcome, 'PASS', 'successful measurement required');
		assert.equal(measured.failed, 0, 'failed measurement');
		assert.equal(measured.skipped, 0, 'skipped measurement');
		assert.equal(measured.passed, expected[0], 'measured test count');
		assert.equal(measured.files, expected[1], 'measured file count');
		assert(measured.command.length > 40 && measured.artifact.startsWith('/tmp/'), 'actual run command and artifact');
		assert.match(measured.artifactSha256, /^[a-f0-9]{64}$/);
		if (id === 'closest-units-foundation-253') {
			assert.equal(measured.executionCommit, 'c952ec7a5d8fa0adfc8f939eaf5c0b94bbd6d423', 'renewed unit execution commit');
			assert.deepEqual(measured.environment, { node: '26.4.0', pnpm: '12.9.1' }, 'renewed unit environment');
			assert.equal(measured.workingTree, 'dirty', 'renewed unit tree identity');
			assert.equal(Object.keys(measured.consumerSha256).length, 5, 'renewed unit consumers');
		}
	}
	assert.equal(sha(sourceRead(value.helper.file)), value.helper.sourceSha256, 'actual fixture import helper drift');
	assert(sourceRead(value.helper.file).includes('compatibility/remote-user/observations.json'), 'actual source fixture import');
	same(value.consumers.map(c => c.id), Object.keys(selections), 'all reviewed runtime consumers');
	const consumed = new Set();
	for (const consumer of value.consumers) {
		const source = sourceRead(consumer.file);
		assert(source.includes(consumer.declaration), 'current consumer declaration');
		assert(source.includes(consumer.selection), 'current dataset selection');
		assert(consumer.assertions.length > 0 && consumer.assertions.every(a => source.includes(a)), 'actual expected-value assertions');
		assert.equal(sha(source), consumer.sourceSha256, 'current consumer source drift');
		const selected = data.cases.filter(selections[consumer.id]).map(c => c.id);
		assert(selected.length > 0, 'nonempty current dataset');
		assert.equal(new Set(consumer.passedCaseIds).size, consumer.passedCaseIds.length, 'duplicate runtime case');
		for (const id of consumer.passedCaseIds) {
			assert(data.cases.some(c => c.id === id), 'unknown runtime case ID');
			consumed.add(id);
		}
		same(consumer.passedCaseIds, selected, 'complete actual case consumption');
		assert.equal(consumer.passedCaseCount, selected.length, 'measured consumed case count');
		assert(value.measurements[consumer.measurement]?.outcome === 'PASS', 'consumer successful measurement');
	}
	for (const [file, digest] of Object.entries(value.measurements['closest-units-foundation-253'].consumerSha256)) {
		assert.equal(sha(sourceRead(file)), digest, 'renewed unit source identity');
	}
	same([...consumed], data.cases.map(c => c.id), 'all 95 cases consumed');
	for (const check of value.runtimeChecks) {
		assert(check.passed > 0 && value.measurements[check.measurement]?.outcome === 'PASS', 'runtime check measured');
		const source = sourceRead(check.file);
		assert(check.declarations.length && check.declarations.every(title => source.includes(`test('${title}',`)), 'actual runtime declarations');
		assert.equal(sha(source), check.sourceSha256, 'runtime check source drift');
	}
	for (const files of Object.values(data.bindings)) {
		for (const file of files) {
			assert([...value.consumers, ...value.runtimeChecks].some(c => c.file === file), 'declared runtime file consumed');
		}
	}
	assert.equal(sha(JSON.stringify(value)), '1a9693700e6c60549fb01a753e6b55ca1aad14002b83422db06a563884f894f7', 'reviewed finite runtime binding drift');
}

test('current runtime has reviewed consumer bindings and successful measurements', () => validateRuntime(runtime()));
for (const [name, mutate, expected] of [
	['missing measurement', d => { delete d.measurements.integration; }, /missing measurement/],
	['failed measurement', d => { d.measurements.process.outcome = 'FAIL'; }, /successful measurement/],
	['failed test count', d => { d.measurements['closest-units'].failed = 1; }, /failed measurement/],
	['skipped measurement', d => { d.measurements.integration.skipped = 1; }, /skipped measurement/],
	['missing renewed unit measurement', d => { delete d.measurements['closest-units-foundation-253']; }, /missing measurement/],
	['failed renewed unit measurement', d => { d.measurements['closest-units-foundation-253'].outcome = 'FAIL'; }, /successful measurement/],
	['unmeasured renewed source', d => { d.measurements['closest-units-foundation-253'].consumerSha256['packages/backend-next/test/unit/note/create-note.test.ts'] = '0'.repeat(64); }, /renewed unit source identity/],
	['missing consumer', d => { d.consumers.pop(); }, /all reviewed runtime consumers/],
	['dropped case consumption', d => { d.consumers[0].passedCaseIds.pop(); }, /complete actual case consumption/],
	['unknown runtime case ID', d => { d.consumers[0].passedCaseIds[0] = 'invented'; }, /unknown runtime case/],
	['unmeasured consumer', d => { d.consumers[0].measurement = 'invented'; }, /consumer successful measurement/],
	['wrong consumer declaration', d => { d.consumers[0].declaration = 'invented'; }, /current consumer declaration/],
	['source drift', d => { d.consumers[0].sourceSha256 = '0'.repeat(64); }, /current consumer source drift/],
	['missing assertions', d => { d.consumers[0].assertions = []; }, /actual expected-value assertions/],
	['invented upstream HTTP', d => { d.upstreamHttpMeasured = true; }, /no upstream full HTTP/],
	['premature implementation pin', d => { d.implementationCommit = 'b228a56f003b69d92b6eed2337af60e1ad9c9ad2'; }, /reviewed implementation commit/],
]) {
	test(`runtime reconciliation rejects ${name}`, () => {
		const value = runtime(); mutate(value);
		assert.throws(() => validateRuntime(value), expected);
	});
}
test('runtime reconciliation rejects removal of expected-value comparison even with a new source digest', () => {
	const value = runtime();
	const consumer = value.consumers[0];
	const source = read(consumer.file).replace(consumer.assertions[0], '');
	consumer.sourceSha256 = sha(source);
	assert.throws(() => validateRuntime(value, dataset(), file => file === consumer.file ? source : read(file)), /actual expected-value assertions/);
});

test('declared consumer bindings are documented alongside actual runtime bindings', () => {
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
