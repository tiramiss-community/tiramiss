/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import vm from 'node:vm';

const upstreamCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const manifest = {
 path: 'packages/backend/src/core/activitypub/ApRendererService.ts',
 sha256: '8e4bcdcb5d062ffb707b0e038e5e1f62f0afca2ac4ddaa44c10e1b21bcbf1098',
 gitBlob: '601edcebe931a2c98e1bf967debdbe8c91e508ad',
 methods: { renderPerson: '409ee63404fdfbc27bc4c199b34166e30cef4ce137b26cd053ab92eb84a6ec97' },
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert(['--write', '--check'].includes(process.argv[2]));
assert(process.env.UPSTREAM_ROOT, 'UPSTREAM_ROOT required');
const git = async (...args) => (await promisify(execFile)('git', ['-C', process.env.UPSTREAM_ROOT, ...args], { encoding: 'buffer', maxBuffer: 4000000 })).stdout;
const bytes = readFileSync(`${process.env.UPSTREAM_ROOT}/${manifest.path}`);
assert.equal(sha(bytes), manifest.sha256, 'complete source SHA256');
assert.deepEqual(bytes, await git('show', `${upstreamCommit}:${manifest.path}`), 'checkout equals pinned Git bytes');
assert.equal((await git('rev-parse', `${upstreamCommit}:${manifest.path}`)).toString().trim(), manifest.gitBlob);
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const ts = require('typescript');
const sf = ts.createSourceFile(manifest.path, bytes.toString(), ts.ScriptTarget.Latest, true);
const method = sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ApRendererService').members.find(n => n.name?.getText(sf) === 'renderPerson');
assert.equal(sha(method.getText(sf)), manifest.methods.renderPerson, 'literal renderPerson SHA256');
const literal = `(async function(${method.parameters.map(p => p.getText(sf)).join(',')})${method.body.getText(sf)})`;
const corpusBytes = readFileSync(new URL('./local-actor-fields-corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
assert.equal(corpus.upstreamCommit, upstreamCommit);
assert.equal(corpus.cases.length, corpus.bounds.cases);
assert.equal(new Set(corpus.cases.map(c => c.id)).size, corpus.cases.length);
const cases = [];
for (const c of corpus.cases) {
 const user = { ...corpus.defaults.user, ...c.user };
 const events = [];
 const renderPerson = vm.runInNewContext(ts.transpile(literal, { target: ts.ScriptTarget.ES2022 }), { URL, mfm: { parse: value => value } });
 const fail = stage => { if (c.fail === stage) throw Error(`${stage} unavailable`); };
 const receiver = {
  config: { url: corpus.defaults.url },
  userEntityService: { genLocalUserUri: id => `${corpus.defaults.url}/users/${id}` },
  userProfilesRepository: { findOneByOrFail: async where => { assert.deepEqual(Object.keys(where), ['userId']); assert.equal(where.userId, user.id); events.push('profile'); fail('profile'); return { ...corpus.defaults.profile, ...c.profile }; } },
  driveFilesRepository: { findOneBy: async where => { assert.equal(where.id, user.avatarId); events.push('media'); fail('media'); return null; } },
  getEmojis: async values => { assert.deepEqual(values, user.emojis); events.push('tags'); fail('tags'); return []; },
  userKeypairService: { getUserKeypair: async id => { assert.equal(id, user.id); events.push('key'); fail('key'); return {}; } },
  renderKey: () => null, renderImage: () => null, renderIdenticon: () => null, renderSystemAvatar: () => null, renderSystemBanner: () => null,
  renderEmoji: () => { throw Error('outside finite corpus'); }, renderHashtag: () => { throw Error('outside finite corpus'); },
  mfmService: { toHtml: value => { events.push('conversion'); fail('conversion'); return value; } },
 };
 try {
  const person = await renderPerson.call(receiver, user);
  assert.equal(c.fail, undefined, 'declared rejection must occur');
  // Serialize first: absent conditional properties stay absent (not undefined sentinels).
  const json = JSON.parse(JSON.stringify(person));
  cases.push({ id: c.id, expected: { json: Object.fromEntries(corpus.projection.filter(k => Object.hasOwn(json, k)).map(k => [k, json[k]])), events } });
 } catch (error) {
  assert(c.fail, `unexpected source failure in ${c.id}: ${error.message}`);
  assert.equal(error.message, `${c.fail} unavailable`, 'only the declared double may reject');
  cases.push({ id: c.id, expected: { error: { name: error.name, message: error.message }, events } });
 }
}
const result = { upstreamCommit, manifest, corpusSha256: sha(corpusBytes), bounds: corpus.bounds, doubles: corpus.doubles, projection: corpus.projection, cases };
const output = `${JSON.stringify(result, null, 2)}\n`;
const target = new URL('./local-actor-fields-observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output);
else assert.equal(readFileSync(target, 'utf8'), output, 'frozen literal-source observations');
console.log(`local-actor-fields source: ${cases.length} cases ${process.argv[2]}`);
