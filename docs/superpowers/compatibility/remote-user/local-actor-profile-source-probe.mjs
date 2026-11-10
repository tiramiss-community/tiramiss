/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const upstreamCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT;
assert(root, 'UPSTREAM_ROOT required');
assert(['--write', '--check'].includes(process.argv[2]));
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const backendRequire = createRequire(`${root}/packages/backend/package.json`);
const ts = require('typescript');
const hashes = {
 'core/activitypub/ApRendererService.ts': '8e4bcdcb5d062ffb707b0e038e5e1f62f0afca2ac4ddaa44c10e1b21bcbf1098',
 'core/MfmService.ts': '494918ebbe07f3e1850f923df5f57fffdb3241c35a08066efe417e542496b6c0',
 'misc/escape-html.ts': '35236da6de026b969f0af3f27d873d1d81d8678fb60ab3cdfdf8c0d04cca67df',
 'misc/prelude/array.ts': '8319bf6a858b2afb934e50595798c2d914388c077d6bf49a2338a5f0520bcdc4',
};
const sha = x => createHash('sha256').update(x).digest('hex');
const sources = Object.fromEntries(Object.entries(hashes).map(([path, hash]) => {
 const text = readFileSync(`${root}/packages/backend/src/${path}`, 'utf8');
 assert.equal(sha(text), hash, `fixed source ${path}`);
 return [path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)];
}));
const globals = { URL, mfm: backendRequire('mfm-js') };
const methods = {};
function evaluate(text) { return vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), globals); }
function method(path, klass, name) {
 const sf = sources[path];
 const owner = sf.statements.find(s => ts.isClassDeclaration(s) && s.name.text === klass);
 const m = owner.members.find(s => s.name?.getText(sf) === name);
 methods[`${klass}.${name}`] = { path, sha256: sha(m.getText(sf)) };
 return evaluate(`(${m.modifiers?.some(s => s.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${m.parameters.map(p => p.getText(sf)).join(',')})${m.body.getText(sf)})`);
}
function helper(path, name) {
 const sf = sources[path]; const fn = sf.statements.find(s => ts.isFunctionDeclaration(s) && s.name.text === name);
 methods[name] = { path, sha256: sha(fn.getText(sf)) };
 globals[name] = evaluate(`(${fn.getText(sf).replace(/^export /, '')})`);
}
helper('misc/escape-html.ts', 'escapeHtml');
helper('misc/prelude/array.ts', 'concat');
helper('misc/prelude/array.ts', 'intersperse');
const render = method('core/activitypub/ApRendererService.ts', 'ApRendererService', 'renderPerson');
const html = method('core/MfmService.ts', 'MfmService', 'toHtml');
const empty = { description: null, followedMessage: null, fields: [], birthday: null, location: null };
const cases = [
 ...[null, '', 'line1\nline2', '[label](https://example.com/a?b=1&c=2)', '@alice @bob@remote.test', '#プロフィール', '**bold**', '$[ruby single]'].map((description, i) => ({ id: `description-${i}`, profile: { ...empty, description } })),
 { id: 'fields', profile: { ...empty, fields: ['http://example.com', 'https://example.com/path?x=1&y=2 trailing <b>x</b>', 'HTTPS://example.com', 'https://[invalid', 'https://localhost', 'www.example.com', '<b>raw</b>'].map((value,i) => ({ name: `field${i}`, value })) } },
 { id: 'values', name: 'Alice <name>', profile: { ...empty, followedMessage: 'hello **raw**', birthday: '2000-01-02', location: 'Tokyo' } },
 { id: 'empty-values', profile: { description: '', followedMessage: '', fields: [], birthday: '', location: '' } },
 { id: 'missing-profile', fail: 'missing' }, { id: 'database-error', fail: 'database' },
];
const keys = ['name','summary','_misskey_summary','_misskey_followedMessage','attachment','vcard:bday','vcard:Address'];
for (const c of cases) {
 const user = { id:'local', username:'alice', name: c.name ?? null, emojis:[], tags:[], isBot:false, isLocked:true, isExplorable:false };
 const receiver = {
  config: { url:'https://local.test' }, userEntityService: { genLocalUserUri: id => `https://local.test/users/${id}` },
  userProfilesRepository: { findOneByOrFail: async ({userId}) => { assert.equal(userId,'local'); if (c.fail) throw Error(c.fail === 'missing' ? 'profile missing' : 'database unavailable'); return c.profile; } },
  getEmojis: async () => [], userKeypairService: { getUserKeypair: async () => ({}) }, renderKey: () => ({ publicKeyPem:'public-key-double' }),
  renderIdenticon: () => null, mfmService: { toHtml: nodes => html.call({ config: { url:'https://local.test' } },nodes) },
 };
 try {
  const person = await render.call(receiver,user);
  const raw = Object.fromEntries(keys.filter(k => Object.hasOwn(person,k)).map(k => [k,person[k] === undefined ? { $undefined:true } : person[k]]));
  c.expected = { raw, json: JSON.parse(JSON.stringify(Object.fromEntries(keys.filter(k => Object.hasOwn(person,k)).map(k => [k,person[k]])))) };
 } catch (e) { c.expected = { error: { name:e.name, message:e.message } }; }
}
const result = { schemaVersion:1, upstreamCommit, upstreamHttpMeasured:false, sourceSha256:hashes, methods,
 doubles: { profileRepository:'in-memory required read; missing/DB failure injected', media:'no avatar/banner; renderIdenticon null', emoji:'empty emojis/tags', key:'getUserKeypair/renderKey fixed dummy; excluded from projection', userUri:'literal https://local.test/users/<id>' },
 bindings: ['ApRendererService.renderPerson','MfmService.toHtml','escapeHtml','concat','intersperse'], cases };
const output = JSON.stringify(result,null,2)+'\n';
const file = new URL('./local-actor-profile-observations.json', import.meta.url);
if(process.argv[2] === '--write') writeFileSync(file,output); else assert.equal(readFileSync(file,'utf8'),output);
console.log(`local actor profile source: ${cases.length} cases ${process.argv[2]}`);
