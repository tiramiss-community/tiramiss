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
const manifest = [
  {
    "path": "packages/backend/src/core/activitypub/ApRendererService.ts",
    "klass": "ApRendererService",
    "sha256": "8e4bcdcb5d062ffb707b0e038e5e1f62f0afca2ac4ddaa44c10e1b21bcbf1098",
    "gitBlob": "601edcebe931a2c98e1bf967debdbe8c91e508ad",
    "methods": {
      "renderPerson": "409ee63404fdfbc27bc4c199b34166e30cef4ce137b26cd053ab92eb84a6ec97",
      "renderImage": "94b2ff87b6c429deb94a26232cbcbace546147d3cbc5697bd696f926aaab2c7d",
      "renderIdenticon": "5802cb350b6b5a377fdde5366f7288a4fa9a0deac85a2b51ae5ab8c792366f4e",
      "renderSystemAvatar": "bdaa8399d001085dc5191c65440c9374b4ad9809de288e838a5fe75ef8535180",
      "renderSystemBanner": "f3de587e501641b5b0785a4f615ad2db1513932630b4ad4bf58baa338abac3e9"
    }
  },
  {
    "path": "packages/backend/src/core/entities/DriveFileEntityService.ts",
    "klass": "DriveFileEntityService",
    "sha256": "a48a07792b784a3ded4364594d346e2cd2d9a7e0a506b56b082325a8f41ca738",
    "gitBlob": "1865d494c4ba39d84daa62501469895e7224a3fb",
    "methods": {
      "getPublicUrl": "09996dc02d88f72f98206a35ca2f41396057e133ec4365ea1206429f6f226c24",
      "getProxiedUrl": "5da80d298150002f856c758001957886560ad956f7dc4e2abb3949bd3fe54c97"
    }
  },
  {
    "path": "packages/backend/src/core/entities/UserEntityService.ts",
    "klass": "UserEntityService",
    "sha256": "c986907bacb822863fe19214b7ec1443c02ebb028820f33932e7cde7f47f6464",
    "gitBlob": "7b932e3230699f4266ff4860d0c850c41038047a",
    "methods": {
      "getIdenticonUrl": "6059f11d806e180dd0cbb1432977d80ac233ee1040effd48cf5f240142f653a5"
    }
  },
  {
    "path": "packages/backend/src/misc/prelude/url.ts",
    "klass": null,
    "sha256": "23157930e879afe70598a81c2e2671e2ceaee6a71023afc2f7b4a15fecb58e9d",
    "gitBlob": "270a0750754eac81c651b7090bd0a7c2d7b3c798",
    "methods": {
      "query": "e31749d7aa1ba1b6f021364e477bd7d39d5d6f63de1d850c0c89cd85236cd816",
      "appendQuery": "566f5d75d99a226d39684a01742794b6d180d3a8837afc058bef330119da992f"
    }
  }
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert(['--write', '--check'].includes(process.argv[2]));
assert(process.env.UPSTREAM_ROOT, 'UPSTREAM_ROOT required');
const git = async (...args) => (await promisify(execFile)('git', ['-C', process.env.UPSTREAM_ROOT, ...args], { encoding: 'buffer', maxBuffer: 4000000 })).stdout;
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const ts = require('typescript');
const context = vm.createContext({ URL, encodeURIComponent });
const methods = {};
for (const entry of manifest) {
 const bytes = readFileSync(`${process.env.UPSTREAM_ROOT}/${entry.path}`);
 assert.equal(sha(bytes), entry.sha256, 'complete source fingerprint');
 assert.deepEqual(bytes, await git('show', `${upstreamCommit}:${entry.path}`), 'checkout bytes equal pinned Git object');
 assert.equal((await git('rev-parse', `${upstreamCommit}:${entry.path}`)).toString().trim(), entry.gitBlob);
 const sf = ts.createSourceFile(entry.path, bytes.toString(), ts.ScriptTarget.Latest, true);
 const members = entry.klass ? sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === entry.klass).members : sf.statements;
 for (const [name, hash] of Object.entries(entry.methods)) {
  const method = members.find(n => n.name?.getText(sf) === name);
  assert.equal(sha(method.getText(sf)), hash, `literal method ${name}`);
  const body = `(${method.modifiers?.some(n => n.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${method.parameters.map(p => p.getText(sf)).join(',')})${method.body.getText(sf)})`;
  methods[name] = vm.runInContext(ts.transpile(body, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context);
  if (!entry.klass) context[name] = methods[name];
 }
}
const corpusBytes = readFileSync(new URL('./local-actor-images-corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
assert.equal(corpus.upstreamCommit, upstreamCommit);
const cases = [];
for (const c of corpus.cases) {
 const events = [];
 const config = { ...corpus.defaults.config, ...c.config };
 const meta = { ...corpus.defaults.meta, ...c.meta };
 const user = { ...corpus.defaults.user, ...c.user };
 const files = Object.fromEntries(Object.entries(c.files ?? {}).map(([id, patch]) => [id, { ...corpus.defaults.file, ...patch }]));
 const receiver = {
  ...methods, config, meta,
  userEntityService: { genLocalUserUri: id => `${config.url}/users/${id}`, getIdenticonUrl: user => methods.getIdenticonUrl.call({ config, meta }, user) },
  driveFileEntityService: { getPublicUrl: file => methods.getPublicUrl.call({ config, meta, getProxiedUrl: methods.getProxiedUrl }, file) },
  driveFilesRepository: { findOneBy: async where => { events.push({ op: 'file', id: where.id }); assert.deepEqual(Object.keys(where), ['id']); if (c.fail?.file === where.id) throw Error(`file ${where.id} unavailable`); return files[where.id] ?? null; } },
  userProfilesRepository: { findOneByOrFail: async where => { events.push({ op: 'profile' }); assert.equal(where.userId, user.id); if (c.fail?.profile) throw Error('profile unavailable'); return corpus.defaults.profile; } },
  getEmojis: async () => { events.push({ op: 'tags' }); if (c.fail?.tags) throw Error('tags unavailable'); return []; },
  userKeypairService: { getUserKeypair: async id => { events.push({ op: 'key' }); assert.equal(id, user.id); if (c.fail?.key) throw Error('key unavailable'); return {}; } },
  renderKey: () => null,
 };
 try {
  const person = await methods.renderPerson.call(receiver, user);
  cases.push({ id: c.id, expected: { json: JSON.parse(JSON.stringify({ icon: person.icon, image: person.image })), events } });
 } catch (error) { cases.push({ id: c.id, expected: { error: { name: error.name, message: error.message }, events } }); }
}
const result = { schemaVersion: 1, upstreamCommit, corpusSha256: sha(corpusBytes), manifest,
 evidence: 'literal pinned source methods with doubles; not upstream full-server HTTP/PG',
 doubles: { files: 'independent findOneBy({id}); plain rows/missing/rejection', profile: 'required empty profile or rejection', meta: 'explicit iconUrl/bannerUrl/proxyRemoteFiles', config: 'explicit effective normalized URL/host/proxy settings; production normalization tested separately', tags: 'getEmojis returns [] or rejects; user tags empty', key: 'getUserKeypair returns {} or rejects; renderKey null', mfm: 'null description; no parser/html execution' }, cases };
const { cases: observations, ...metadata } = result;
const output = JSON.stringify(metadata, null, 2).slice(0, -2) + ',\n  "cases": [\n' + observations.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}\n';
const target = new URL('./local-actor-images-observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output); else assert.equal(readFileSync(target, 'utf8'), output);
console.log(`local actor images source: ${cases.length} cases ${process.argv[2]}; pinned Git bytes + method fingerprints verified`);
