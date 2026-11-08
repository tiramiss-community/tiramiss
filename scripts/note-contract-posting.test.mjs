/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const note = 'docs/superpowers/compatibility/note/';
const read = file => readFileSync(new URL(file, root), 'utf8');
const json = file => JSON.parse(read(file));
const ledger = json(`${note}n7/coverage.json`);
const historical = json(`${note}coverage.json`);
const inventory = json('docs/superpowers/compatibility/backend-inventory/contracts.json').contracts;
const sha = value => createHash('sha256').update(value).digest('hex');
const unique = (values, label) => assert.equal(new Set(values).size, values.length, `duplicate ${label}`);
const same = (actual, expected, label) => assert.deepEqual([...actual].sort(), [...expected].sort(), label);
const owners = value => assert.ok(Array.isArray(value) && value.length && value.every(x => Number.isInteger(x) && x > 0), 'remaining owners');
const provenance = new Set(['upstream-http', 'source-method', 'new-runtime', 'limitation']);

// Audited finite bindings; update only after reviewing the actual consumer and dataset.
const bindings = {
  "evidence": {
    "create": "f56778353b28026ebac281db22e651afa1d1563ecc30ffe786c507a93bf4c625",
    "show": "75303b52c610263905b5203ee32d12fac3dc886f5e87e3b3bcedd9eda94e6cdb",
    "plain-show": "aa29f9c306c486ed7f634d3fef54738d30027f7e8e6da8bad3a0b716f5f1ea9e",
    "user-count": "a126b35c5fbacd739458d46fbbc807cfdb39c651415e7a5b268fcc6c68bdfe43",
    "channel-count": "8331a645efd6d7ed011d92214cfd2d555a87b020a4bc595b70c9a1b4d9422e7c",
    "read-auth": "f203117b880a6432c3a79e60176396d963a9d5693f9b7ff921aabcab70355fc5",
    "moved-delete": "068ded561e9f77c3fc3ec3e8216c7cde5f54d861d9f1b3554b41bed113013483",
    "rate": "0c8962f51338092c3aa77682008fe346cdb4b1ae8ad9cb33c41904be0344a6f4",
    "count": "a789922265121c9c3560bc01c1c4dd38751f22fdbf421ae6f0529173c8ef7c11",
    "detail": "fbfe8f774c112a0edd5424ffbf8b309f55a3eb846266e88d5c2b7d30facdd526",
    "show-errors": "6c9fede461f4aa998959dfb370e8663e8cea60367f0cce493ed438fd0eb090ef",
    "show-time": "894eaafb727475cd1020fe2a97adbeddc0e77060557afb887d81126c98333dac",
    "delivery": "014a64eb4042bab5655ade550dd87f9adf23afee843023ee4bfe4c041ae7892a",
    "delete-http": "e8ed999436709917903ef2db1b0748c062f53d61ec8732a9aa8417c16b1185d7",
    "delete-audit": "a1d0622ec18168e8d93e8dcfa8466bb268ef92156f65a16bee4dfbd56877fca3",
    "restart": "a4b0702439f42ca85942fab14c4fe350986dae5113534b78fb7921777cfd68c6",
    "reject": "f3f4c1922b10a1556a95ca0d80ac3d9f9fc540379bcefc400473b9bd078df959",
    "terminal": "377ceace1e68366ff4e30f1742cbba0fab203215469db1b60ff9fddc213cee9f",
    "handoff": "573723a5f81d3a7050e6753902bcf7b6121b14301872c6899601e1f3b08262f1",
    "scheduler": "8675969e26bcda38a9c354360b22d6ce283608f581b10c57637b63a1d74f9756",
    "missing-handlers": "57eca24c025f54b68a945ff732e1cf963928f5119614dadecb2320b40a40c997",
    "correction": "e4f9b3a704ea5985145abb75373df4f1bc92929c2d46e7344c56200649d93cd2",
    "cleanup": "4d5321b53762cec904f008dfeacad458fbadc11e4ea66785bfe7095973c2e6b7",
    "limitation": "391b419aa77a7591023877ee123d14252a116242f3dc01a64490f853278200f1",
    "delete-ap": "db803c5dedaf2daa70cf947f03fbc8a3e68aa7955c0aad70d23415892d2d2ea5",
    "n3": "54eec3b34146861ad34e53b1e7ba0ff0a6816d8050c6079333b945580c58a8e2"
  },
  "cases": {
    "C1": "856db1d7043573778784a97278d3092d29cb5f1c0c40164f3a5a3b5a06152086",
    "C2": "6bbdecdd98a715750c1922e90e7047386d98c7e42e668c40877d077ca20515c2",
    "C3": "8c83b13be6ba30c2372d37014c23fb1c39657db042ebfdd830bbd04306717c12",
    "C4": "ed1ad7a39b51c798cac52a9a8d75631076be0ee5bba02b04e050ff2d0c180b68",
    "C5": "1ff5c5e3e2326a2a146528c6007a4bcf8793f5becfe2e749aedcff198d32c3eb",
    "C6": "c9a52f05160bf5fc520159124a82b1f8a188aabbd61120f3c3cd720df572a5d1",
    "C7": "54f7ad089e379edf56644cd03c55713969c96d24bb22b107780e2ba379ec7c84",
    "C8": "b4a820763722ed66fdac8c73d8ebc4fba865587709755dd79c042042d2dd3c42",
    "C9": "2173f03937d5921f54736482199d2e708c014b0435f6ee95874aec62d5251d11",
    "C10": "9c4abb08bf87d785ff18c62b2277471a6c3f975e5ca8f81d6bf577f74e5ac027"
  },
  "crossDomain": "600b467204eea60ecb998e7d1c451a792f5131d03ec6af43b2907994c647cd9f",
  "fixtureDigests": "abf7cc7181d9f498b3d8c0a5f1d00bd69aa944ab8a36eb98ee9e7418effe22c7",
  "sliceDatasets": "50280d07681d4a55dc5fcfe886016949cb659a06d99ead7c8aca4c21e07b458c",
  "profiles": "e9914118e6dabb04b4fccfa17a211a065a7814d01fb3fa4ccc7f54510d82d467",
  "failureDispositions": "600937144af9952e473acf97d110f56b39de0b259a54338e9d1ff0398a40d3bf",
  "blockers": "963a1911cd4d9788775a69f4da949110081e1859a253ca3af2de1a0f824631a6",
  "parentAudit": "f7ca3de1df81eceaba3660b4f8c4260ff4ab4c9b65859bf230b75b8a47854a36"
};

function validate(value) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.upstreamCommit, historical.upstreamCommit);
	assert.equal(value.postingComplete, false, 'posting completion remains blocked');
	assert.equal(value.notesCreateStatus, 'partial', 'create stays partial');
	unique(value.cases.map(x => x.id), 'C groups');
	same(value.cases.map(x => x.id), historical.cases.filter(x => /^C\d+$/.test(x.id)).map(x => x.id), 'C groups');
	unique(value.contracts.map(x => x.id), 'inventory IDs');
	const primary = inventory.filter(x => ['notes', 'ap-outbound'].includes(x.domain));
	assert.equal(primary.length, 104);
	same(value.contracts.map(x => x.id), primary.map(x => x.id), 'inventory identities');
	for (const row of value.contracts) {
		const original = primary.find(x => x.id === row.id);
		assert.equal(row.inventoryStatus, original.status, `inventory status ${row.id}`);
		assert.equal(row.domain, original.domain);
		assert.ok(value.profiles[row.profile], 'known profile');
		owners(row.remainingOwners);
		assert.deepEqual(row.remainingOwners, value.profiles[row.profile].remainingOwners, 'contract owners');
	}
	for (const [id, ref] of Object.entries(value.evidence)) {
		assert.ok(provenance.has(ref.provenance), 'known provenance');
		const source = read(ref.file);
		assert.ok(source.includes(`('${ref.testTitle}',`), 'exact declaration title');
		assert.equal(sha(source), ref.sourceSha256, 'evidence source drift; re-review assertions');
		assert.ok(ref.assertions.length > 30, 'concrete assertion description');
		if (ref.dataset) {
			const data = ref.dataset;
			unique(data.caseIds, 'dataset cases');
			assert.ok(data.caseIds.length, 'nonempty dataset');
			assert.ok(source.includes(data.sourceExpression), 'dataset source expression');
			if (data.file.endsWith('.json')) {
				const fixture = json(data.file);
				for (const key of data.caseIds) assert.ok(Array.isArray(fixture) ? fixture.some(x => x.id === key) : Object.hasOwn(fixture, key), 'dataset case exists');
			} else {
				assert.equal(data.file, ref.file, 'inline parameters belong to consumer');
				assert.equal(data.caseIds.length, data.parameters.length, 'inline parameter count');
			}
		}
		// Reviewed bindings pin the finite dataset/parameter/title/provenance tuples.
		// Source hashes detect drift; neither hashes nor title matching prove parity.
		assert.equal(sha(JSON.stringify(ref)), bindings.evidence[id], `binding drift ${id}`);
	}
	same(Object.keys(value.evidence), Object.keys(bindings.evidence), 'known evidence IDs');
	const evidence = ids => {
		assert.ok(Array.isArray(ids), 'evidence IDs');
		unique(ids, 'evidence IDs');
		for (const id of ids) assert.ok(value.evidence[id], 'unknown evidence ID');
	};
	const observation = ref => {
		assert.ok(provenance.has(ref.provenance), 'observation provenance');
		assert.ok(Object.hasOwn(json(ref.file), ref.key), 'JSON key exists');
	};
	for (const group of value.cases) {
		owners(group.owners); owners(group.remaining.owners);
		assert.ok(group.remaining.reason.length > 20);
		const original = historical.cases.find(x => x.id === group.id);
		unique(group.observations.map(x => `${x.observation.file}:${x.observation.key}`), 'observations');
		for (const item of group.observations) observation(item.observation);
		same(group.observations.map(x => `${x.observation.file}:${x.observation.key}`), original.evidence.map(x => `${note}${x.file}:${x.key}`), 'all original observations');
		for (const item of group.observations) {
			evidence(item.evidence);
			assert.ok(item.evidence.length || item.remaining, 'qualified observation');
			assert.ok(item.assertions.length > 30, 'concrete assertions');
			if (item.remaining) { owners(item.remaining.owners); assert.ok(item.remaining.reason.length > 30); }
			if (item.caseId) for (const id of item.evidence) assert.ok(value.evidence[id].dataset?.caseIds.includes(item.caseId), 'observation dataset binding');
		}
		if (group.additionalEvidence) evidence(group.additionalEvidence);
		if (group.sourceDataset) {
			const ref = group.sourceDataset;
			assert.equal(ref.provenance, 'source-method');
			assert.ok(json(ref.file)[ref.key].some(x => x.id === ref.caseId), 'source dataset case');
		}
		assert.equal(sha(JSON.stringify(group)), bindings.cases[group.id], 'observation binding drift');
	}
	unique(value.failureDispositions.map(x => x.id), 'F groups');
	same(value.failureDispositions.map(x => x.id), Array.from({ length: 8 }, (_, i) => `F${i + 1}`), 'F groups');
	for (const item of value.failureDispositions) {
		assert.equal(item.retiredGuaranteesImplemented, false, 'retired guarantee cannot be promoted');
		owners(item.remainingOwners); evidence(item.evidence);
		assert.ok(item.applicable.length > 30 && item.excluded.length > 30, 'qualified F disposition');
		for (const ref of item.observations ?? []) observation(ref);
	}
	for (const item of Object.values(value.profiles)) { evidence(item.evidence); owners(item.remainingOwners); if (item.reference) read(item.reference); }
	for (const item of value.crossDomain) { owners(item.remainingOwners); assert.ok(value.profiles[item.profile]); }
	assert.equal(sha(JSON.stringify(value.crossDomain)), bindings.crossDomain, 'cross-domain responsibilities drift');
	unique(value.blockers.map(x => x.id), 'blockers');
	same(value.blockers.map(x => x.id), ['unknown-remote-mention-501', 'stale-remote-refresh'], 'remote blockers');
	for (const blocker of value.blockers) {
		assert.equal(blocker.status, 'unresolved', 'unresolved blocker');
		assert.equal(blocker.owner, 195, 'blocker owner');
		assert.equal(blocker.provenance, 'limitation');
		same(blocker.blocks, [176, 127], 'completion blockers'); evidence(blocker.evidence);
		if (blocker.implementation) read(blocker.implementation);
	}
	assert.equal(value.evidence.limitation.provenance, 'limitation');
	for (const [file, digest] of Object.entries(value.fixtureDigests)) assert.equal(sha(read(file)), digest, 'fixture dataset drift');
	assert.equal(sha(JSON.stringify(value.fixtureDigests)), bindings.fixtureDigests, 'fixture bindings drift');
	for (const item of value.sliceDatasets) { for (const key of item.keys) observation({ file: item.file, key, provenance: item.provenance }); evidence(item.evidence); }
	assert.equal(sha(JSON.stringify(value.sliceDatasets)), bindings.sliceDatasets, 'slice dataset drift');
	const audit = value.parentAudit;
	same(Object.keys(audit.unsupportedHandlers), ['system', 'postScheduledNote', 'inbox', 'db', 'relationship', 'objectStorage', 'systemWebhookDeliver'], 'seven unsupported handlers');
	for (const owner of Object.values(audit.unsupportedHandlers)) owners(owner);
	assert.equal(audit.systemSchedulers.count, 9, 'nine system schedulers');
	owners(audit.systemSchedulers.owners); evidence(audit.systemSchedulers.evidence);
	same(audit.requirements.filter(x => x.issue).map(x => x.issue), [160, 162, 163, 164, 165], 'parent initial requirements');
	assert.ok(audit.requirements.some(x => x.id === 'pg-runtime-removal'), 'PG removal');
	for (const item of audit.requirements) { read(item.record); if (item.evidence) evidence(item.evidence); }
	assert.equal(audit.finalIndependentReview, 'PASS');
	assert.equal(audit.issueStateAtAudit, 'OPEN');
	assert.equal(audit.wholeBranchReview, 'APPROVE');
	assert.equal(audit.criteria.length, 10, 'current parent criteria');
	for (const criterion of audit.criteria) {
		assert.equal(criterion.result, 'PASS');
		for (const reference of criterion.references) { read(reference.file); assert.ok(Number.isInteger(reference.line) && reference.line > 0); }
	}
	same(audit.closureReferences, ['Closes #124', 'Refs #176', 'Refs #127', 'Refs #139'], 'audited parent and remaining references');
	for (const key of ['profiles', 'failureDispositions', 'blockers', 'parentAudit']) assert.equal(sha(JSON.stringify(value[key])), bindings[key], `ownership/disposition binding drift ${key}`);
}

test('N7 covers every C observation with qualified concrete evidence', () => validate(ledger));
test('N7 records current F dispositions without retired guarantees', () => validate(ledger));
test('N7 preserves posting inventory identities and statuses', () => validate(ledger));
test('N7 refuses completion while remote mention blockers remain', () => validate(ledger));

// Mutations exercise the in-memory ledger only; they never rewrite evidence.
const mutations = [
	['omitted group', x => x.cases.pop(), /C groups/],
	['duplicate group', x => x.cases.push(x.cases[0]), /duplicate C/],
	['unknown group', x => { x.cases[0].id = 'C99'; }, /C groups/],
	['omitted observation', x => x.cases[0].observations.pop(), /observations/],
	['duplicate observation', x => x.cases[0].observations.push(x.cases[0].observations[0]), /duplicate observation/],
	['omitted inventory ID', x => x.contracts.pop(), /inventory identities/],
	['duplicate inventory ID', x => x.contracts.push(x.contracts[0]), /duplicate inventory/],
	['unknown inventory ID', x => { x.contracts[0].id = 'invented'; }, /inventory identities/],
	['promoted inventory row', x => { x.contracts[0].inventoryStatus = 'verified'; }, /inventory status/],
	['unknown provenance', x => { x.evidence.create.provenance = 'parity'; }, /provenance/],
	['missing evidence file', x => { x.evidence.create.file = 'missing.test.ts'; }, /ENOENT/],
	['missing JSON key', x => { x.cases[0].observations[0].observation.key = 'C1-invented'; }, /JSON key/],
	['wrong declaration title', x => { x.evidence.create.testTitle = 'fabricated rendered title'; }, /declaration title/],
	['unknown dataset case', x => { x.evidence.create.dataset.caseIds[0] = 'C1-invented'; }, /dataset case/],
	['wrong dataset parameters', x => { x.evidence.correction.dataset.parameters = ['invented']; }, /binding drift/],
	['missing remaining owner', x => { x.cases[0].remaining.owners = []; }, /remaining owners/],
	['inconsistent contract owners', x => { x.contracts[0].remainingOwners = [999]; }, /contract owners/],
	['dropped remote blocker', x => x.blockers.pop(), /remote blockers/],
	['remote blocker reclassified', x => { x.blockers[0].status = 'accepted-difference'; }, /unresolved blocker/],
	['remote blocker ownership', x => { x.blockers[0].owner = 176; }, /blocker owner/],
	['posting completion', x => { x.postingComplete = true; }, /posting completion/],
	['create promotion', x => { x.notesCreateStatus = 'verified'; }, /create stays partial/],
	['retired guarantee promotion', x => { x.failureDispositions[0].retiredGuaranteesImplemented = true; }, /retired guarantee/],
	['missing F disposition', x => x.failureDispositions.pop(), /F groups/],
	['missing cutover handler', x => { delete x.parentAudit.unsupportedHandlers.inbox; }, /unsupported handlers/],
	['dropped schedulers', x => { x.parentAudit.systemSchedulers.count = 0; }, /nine system schedulers/],
	['limitation relabelled runtime', x => { x.evidence.limitation.provenance = 'new-runtime'; }, /binding drift/],
	['redirected observation consumer', x => { x.cases[0].observations[0].evidence = ['terminal']; }, /observation dataset binding|observation binding drift/],
];
for (const [name, mutate, expected] of mutations) {
	test(`N7 rejects ${name}`, () => {
		const invalid = structuredClone(ledger);
		mutate(invalid);
		assert.throws(() => validate(invalid), expected);
	});
}
