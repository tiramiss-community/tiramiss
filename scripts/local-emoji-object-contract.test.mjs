/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const prefix = new URL('../docs/superpowers/compatibility/remote-user/local-emoji-object-', import.meta.url);
const bytes = suffix => readFileSync(new URL(prefix.href + suffix));
const corpus = JSON.parse(bytes('corpus.json'));
const observed = JSON.parse(bytes('observations.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const get = id => observed.cases.find(row => row.id === id).expected;

test('finite corpus and literal source probe bind to the authoritative Git blobs', () => {
 assert.equal(corpus.source, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(observed.source, corpus.source);
 assert.equal(observed.corpusSha256, sha(bytes('corpus.json')));
 assert.equal(observed.probeSha256, sha(bytes('source-probe.mjs')));
 assert.equal(corpus.cases.length, 53);
 assert.equal(new Set(corpus.cases.map(c => c.id)).size, 53);
 assert.deepEqual(observed.cases.map(c => c.id), corpus.cases.map(c => c.id));
 const checked = new Set();
 for (const entry of observed.manifest) {
  if (checked.has(entry.path)) continue;
  checked.add(entry.path);
  const bytes = execFileSync('git', ['show', `${corpus.source}:${entry.path}`], { maxBuffer: 4000000 });
  assert.equal(sha(bytes), entry.sha256, entry.path);
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), entry.gitBlob);
 }
 for (const path of ['ActivityPubServerService.ts', 'ApRendererService.ts', 'contexts.ts', 'ServerService.ts']) assert([...checked].some(p => p.endsWith('/' + path)));
});

test('only an exact named public local row is visible; sensitive and role restrictions do not gate publication', () => {
 for (const id of ['missing', 'local-only', 'remote-only', 'case-mismatch', 'alias-is-not-name']) {
  assert.equal(get(id).status, 404);
  assert.equal(get(id).body, '');
  assert.equal(get(id).headers['cache-control'], null);
 }
 for (const id of ['public', 'local-remote-same-name', 'sensitive', 'role-restricted', 'specified']) assert.equal(get(id).status, 200);
 for (const row of observed.cases) {
  assert.equal(row.expected.unchanged, true);
  assert(!row.expected.errors.some(error => error.name === 'ReferenceError'));
  for (const [, where] of row.expected.events) assert.equal(where.host, 'isNull');
 }
});

test('literal renderer retains URL/MIME/license and clock fallbacks', () => {
 assert.equal(get('public-url-empty').body.icon.url, corpus.defaults.emoji.originalUrl);
 assert.equal(get('type-null').body.icon.mediaType, 'image/png');
 assert.equal(get('type-empty').body.icon.mediaType, '');
 assert.equal(get('license-null').body._misskey_license.freeText, null);
 assert.equal(get('license-empty').body._misskey_license.freeText, '');
 assert.equal(get('license-unicode').body._misskey_license.freeText, '作者の許諾');
 assert.equal(get('undated').body.updated, corpus.defaults.now);
 assert.equal(get('public').body.updated, corpus.defaults.emoji.updatedAt);
});

test('DB failure is uncached while rendering failure retains the already assigned public cache', () => {
 assert.equal(get('db-failure').status, 500);
 assert.equal(get('db-failure').headers['cache-control'], null);
 assert.equal(get('invalid-date').status, 500);
 assert.equal(get('invalid-date').headers['cache-control'], 'public, max-age=180');
 assert.equal(get('invalid-date').errors[0].name, 'RangeError');
 for (const id of ['none', 'none-before-db-failure']) {
  assert.equal(get(id).status, 403); assert.equal(get(id).body, ''); assert.deepEqual(get(id).events, []);
 }
});

test('Accept fallback and HEAD/OPTIONS remain independent of actor HTML constraints', () => {
 for (const id of corpus.cases.filter(c => c.id.startsWith('accept-')).map(c => c.id)) {
  const e = get(id);
  assert.equal(e.status, 200);
  assert.equal(e.headers.vary, null);
  assert.equal(e.headers['content-type'].startsWith('application/ld+json'), ['accept-ld', 'accept-profile', 'accept-weights'].includes(id));
 }
 assert.equal(get('HEAD').body, '');
 assert.equal(get('HEAD').events.length, 1);
 assert.equal(get('OPTIONS').status, 404);
 assert.equal(get('OPTIONS').headers['access-control-allow-origin'], null);
 assert.deepEqual(get('OPTIONS').events, []);
});

test('router decoding and UTF16 limits precede CORS and federation; decoding happens once', () => {
 for (const id of ['percent-before-none', 'bad-percent-before-none', 'bad-utf8-before-none', 'truncated-utf8-before-none', 'HEAD-malformed', 'OPTIONS-malformed']) {
  assert.equal(get(id).status, 400); assert.equal(get(id).headers['access-control-allow-origin'], null); assert.deepEqual(get(id).events, []);
 }
 for (const id of ['long-before-none', 'long-utf16-before-none']) assert.equal(get(id).status, 414);
 for (const id of ['max-ascii', 'max-utf16', 'empty', 'double-encoded', 'encoded-slash', 'unicode', 'plus-literal']) assert.equal(get(id).status, 200);
 assert.equal(get('double-encoded').body.name, ':%68ello:');
 assert.equal(get('OPTIONS-long').status, 404);
});
