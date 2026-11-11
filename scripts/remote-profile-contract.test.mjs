/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { remoteProfileDigest, remoteProfileSha, validateRemoteProfileEvidence, validateRootVerification } from './remote-profile-evidence.mjs';
const directory = new URL('../docs/superpowers/compatibility/remote-user/', import.meta.url);
const bytes = readFileSync(new URL('remote-profile-observations.json', directory));
const source = JSON.parse(bytes);
const receipt = () => JSON.parse(readFileSync(new URL('remote-profile-runtime-evidence.json', directory)));

function validateSource(value) {
 assert.equal(value.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(value.upstreamHttpMeasured, false);
 assert.equal(value.cases.length, 68);
 assert.equal(new Set(value.cases.map(c => c.id)).size, 68);
 assert.equal(value.sourceStorage.descriptionMaxCharacters, 2048);
 assert.equal(remoteProfileSha(JSON.stringify({ files: value.fullFileSha256, methods: value.methods })), '5b72354747f7312702007a787f32af2ee8f8375362336cdb772e3fd5c8975905', 'literal source bindings');
 for (const c of value.cases) {
  assert.equal(c.provenance, 'literal-source-method');
  assert(c.methods.length > 0 && c.methods.every(m => value.methods[m]), 'known literal methods');
  assert(Array.isArray(c.doubles));
  if (c.area === 'html' || c.area === 'attachment') assert.equal(c.doubles.length, 0);
  assert('result' in c.expected || 'error' in c.expected);
 }
 const get = id => value.cases.find(c => c.id === id).expected;
 for (const area of ['create', 'refresh']) {
  assert.equal(get(`${area}-attachment-priority`).error.message, "Cannot read properties of null (reading 'type')");
  assert(!get(`${area}-attachment-priority`).events.some(e => /^(User|Profile|Key)\./.test(e.op)));
 }
 assert.deepEqual(get('create-bad-summary').events.map(e => e.op), ['emoji', 'transaction.begin', 'User.save', 'transaction.rollback']);
 assert.deepEqual(get('refresh-bad-summary').events.map(e => e.op), ['emoji', 'User.update', 'Key.update']);
 const description = id => get(id).events.find(e => e.op === 'Profile.save').args.description;
 assert.equal(description('create-limit-2048').length, 2048);
 assert.equal(description('create-limit-2049'), description('create-limit-2048'));
 assert.equal(Array.from(description('create-unicode')).length, 2048);
 assert.equal(description('create-truncated-html').length, 2049);
 assert.equal(description('create-expanded-html').length, 2401);
 assert.equal(description('create-tag-single'), '#foo');
 assert.equal(get('create-fields').events.find(e => e.op === 'Profile.save').args.fields[0].value, '[#foo](https://remote.test/tags/foo)');
}

test('finite real profile source retains literal transformers, source storage and error priority', () => {
 assert.equal(remoteProfileSha(bytes), 'f70c760b005e0c4747dfd7a1eed9748537bae1328fb9e21fa1ef2cfbb7cdbe37', 'reviewed finite source corpus');
 validateSource(source);
});
test('profile current bindings require actual parent runs and preserve historical receipts', () => {
 const value = receipt(); validateRemoteProfileEvidence(value);
 const covered = new Set(value.consumers.flatMap(c => c.caseIds));
 assert.deepEqual([...covered].sort(), source.cases.map(c => c.id).sort(), 'all finite cases have actual consumers');
 for (const consumer of value.consumers) {
  assert(value.files[consumer.file], 'consumer measured bytes');
  const text = readFileSync(new URL('../' + consumer.file, import.meta.url), 'utf8');
  assert(text.includes('remote-profile-observations.json'), 'consumer imports independent source corpus');
  for (const anchor of consumer.assertions) assert(text.includes(anchor), 'consumer asserts actual source output');
 }
});
for (const [name, mutate] of [
 ['premature completion', v => { v.postingComplete = true; }],
 ['failed run', v => { v.measurements.integration.outcome = 'FAIL'; }],
 ['missing source replay', v => { delete v.measurements['source-probe']; }],
 ['unmeasured byte', v => { Object.values(v.files)[0].sha256 = '0'.repeat(64); }],
 ['unvalidated file', v => { Object.values(v.files)[0].validatedBy = []; }],
]) {
 test(`profile evidence rejects ${name}`, () => { const value = receipt(); mutate(value); assert.throws(() => validateRemoteProfileEvidence(value)); });
}
test('profile identity projection rejects an unmeasured predecessor', () => {
 assert.throws(() => remoteProfileDigest('packages/backend-next/src/composition/remote-users.ts', '0'.repeat(64)));
});
test('root receipt and available logs are bound to their declared bytes and checks', () => {
 const root = receipt().rootVerification;
 const rootBytes = Buffer.from(JSON.stringify({ status: 'PASS', node: root.node, completedAt: root.completedAt, checks: root.checks }));
 const logBytes = Buffer.from('root log');
 const sample = structuredClone(root);
 sample.receiptSha256 = remoteProfileSha(rootBytes);
 sample.checks[0].sha256 = remoteProfileSha(logBytes);
 const boundBytes = Buffer.from(JSON.stringify({ status: 'PASS', node: sample.node, completedAt: sample.completedAt, checks: sample.checks }));
 sample.receiptSha256 = remoteProfileSha(boundBytes);
 const read = path => path === sample.receipt ? boundBytes : path === sample.checks[0].log ? logBytes : null;
 validateRootVerification(sample, read);
 const changedReceipt = structuredClone(sample); changedReceipt.receiptSha256 = '0'.repeat(64);
 assert.throws(() => validateRootVerification(changedReceipt, read));
 const changedLog = structuredClone(sample); changedLog.checks[0].sha256 = '0'.repeat(64);
 assert.throws(() => validateRootVerification(changedLog, path => path === changedLog.receipt ? null : read(path)));
 const changedChecks = structuredClone(sample); changedChecks.checks[0].passed++;
 assert.throws(() => validateRootVerification(changedChecks, read));
});
