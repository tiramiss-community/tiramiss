/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createPublicKey, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const dir = 'docs/superpowers/compatibility/remote-user/local-actor-alias-key-';
const corpus = JSON.parse(read(dir + 'corpus.json'));
const observed = JSON.parse(read(dir + 'observations.json'));

test('finite route cases are unique, complete and bound to fixed Git source blobs', async () => {
	assert.equal(corpus.source, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observed.source, corpus.source);
	assert.equal(new Set(corpus.cases.map(c => c.id)).size, corpus.cases.length);
	assert.deepEqual(observed.cases.map(c => c.id), corpus.cases.map(c => c.id));
	assert.equal(observed.manifest.length, 6);
	for (const entry of observed.manifest) {
		const { stdout } = await promisify(execFile)('git', ['show', `${corpus.source}:${entry.path}`], { maxBuffer: 4000000 });
		assert.equal(createHash('sha256').update(stdout).digest('hex'), entry.sha256, entry.path);
	}
});
test('fixture public key really converts PKCS1 to the observed SPKI with all postfixes', () => {
	const key = JSON.parse(read(dir + 'key.json'));
	assert.deepEqual(Object.keys(key).sort(), ['pkcs1', 'spki']);
	assert.equal(createPublicKey(key.pkcs1).export({ type: 'spki', format: 'pem' }), key.spki);
	for (const row of observed.key) {
		assert.equal(row.output.publicKeyPem, key.spki);
		assert.equal(row.output.id, row.output.owner + (row.postfix ?? '/publickey'));
	}
});
test('product unit and live test consume observations rather than independent expected snapshots', () => {
	for (const file of ['packages/backend-next/test/unit/federation/actor-alias-key.test.ts', 'packages/backend-next/test/integration/actor-alias-key.test.ts']) {
		assert.match(read(file), /local-actor-alias-key-observations\.json/);
		assert.match(read(file), /local-actor-alias-key-corpus\.json/);
	}
	for (const file of ['acct.ts', 'local-key.ts']) {
		assert.doesNotMatch(read('packages/backend-next/src/modules/federation/' + file), /hono|typeorm|statusCode|Cache-Control/);
	}
});
test('source observations retain explicit empty responses, exception class, production guard and suspended asymmetry', () => {
	const get = id => observed.cases.find(c => c.id === id);
	assert.equal(get('alias-suspended').status, 404);
	assert.equal(get('key-suspended').status, 200);
	assert.equal(get('alias-null-uri').body, '');
	assert.equal(get('alias-key-invalid').headers['cache-control'], 'public, max-age=180');
	assert.equal(get('key-key-missing').headers['cache-control'], null);
	assert.equal(get('key-key-invalid').headers['cache-control'], 'public, max-age=180');
	assert.equal(get('guard-same-31').status, 301);
	assert.equal(get('guard-same-34').status, 406);
	assert.equal(get('guard-29').status, 301);
});

test('review boundaries reject before lookup and preserve empty parameter hooks', () => {
 const get = id => observed.cases.find(c => c.id === id);
 for (const route of ['alias', 'key']) {
  assert.equal(get(`review-${route}-empty-GET-none`).status, 403);
  assert.equal(get(`review-${route}-empty-GET-none`).headers['access-control-allow-origin'], '*');
  for (const name of ['ascii101', 'encoded101', 'unicode101', 'astral102', 'percent101', 'double102']) {
   const row = get(`review-${route}-${name}-GET-none`);
   assert.equal(row.status, 414);
   assert.deepEqual(row.calls, []);
   assert.equal(row.headers['access-control-allow-origin'], null);
  }
 }
});
