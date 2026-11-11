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
const sourcePath = 'packages/backend/src/core/activitypub/ApRendererService.ts';
const sourceSha256 = '8e4bcdcb5d062ffb707b0e038e5e1f62f0afca2ac4ddaa44c10e1b21bcbf1098';
const hashes = {
 renderPerson: '409ee63404fdfbc27bc4c199b34166e30cef4ce137b26cd053ab92eb84a6ec97',
 getEmojis: '86e48acc62b89444ee411c740fa4fbb141c0a186346ca1ae87c7945dcdce1673',
 renderEmoji: 'f89fbf2c7337c944ad0f1611d49aa8dc48e9ee33a8b68a5c40c33ff9a3ce7c54',
 renderHashtag: '191f257ef3b67efbac07f6e94513855111a524d22836f489d147b2aeb2573819',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert(['--write', '--check'].includes(process.argv[2]));
assert(process.env.UPSTREAM_ROOT, 'UPSTREAM_ROOT required');
const text = readFileSync(`${process.env.UPSTREAM_ROOT}/${sourcePath}`, 'utf8');
assert.equal(sha(text), sourceSha256, 'fixed complete source');
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const ts = require('typescript');
const sf = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
const klass = sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ApRendererService');
const methodText = Object.fromEntries(Object.entries(hashes).map(([name, hash]) => {
 const m = klass.members.find(n => n.name?.getText(sf) === name);
 assert.equal(sha(m.getText(sf)), hash, `literal method ${name}`);
 return [name, `(${m.modifiers?.some(n => n.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${m.parameters.map(p => p.getText(sf)).join(',')})${m.body.getText(sf)})`];
}));
const emoji = { name: 'alpha', type: 'image/webp', publicUrl: 'https://cdn.test/alpha', originalUrl: 'https://original.test/alpha', license: 'CC0', localOnly: false, updatedAt: '2020-01-02T03:04:05.000Z' };
const epoch = 1794355200000;
const cases = [
 { id: 'empty', names: [], tags: [], rows: [], cacheFailure: true },
 { id: 'missing', names: ['missing'], tags: [], rows: [] },
 { id: 'order-duplicates', names: ['beta', 'missing', 'alpha', 'beta', 'private'], tags: ['MiXeD', '日本 語/#', 'MiXeD'], rows: [emoji, { ...emoji, name: 'private', localOnly: true }, { ...emoji, name: 'beta', updatedAt: null, type: null, publicUrl: '', license: null }] },
 { id: 'empty-values', names: ['alpha'], tags: [''], rows: [{ ...emoji, type: '', publicUrl: '', originalUrl: '', license: '' }] },
 { id: 'hashtags-only', names: [], tags: ['A%20B', '#raw', 'é', 'É'], rows: [] },
 { id: 'all-private', names: ['alpha', 'alpha'], tags: ['visible'], rows: [{ ...emoji, localOnly: true, updatedAt: null }] },
 { id: 'clock-before-key', names: ['alpha', 'alpha'], tags: ['after'], rows: [{ ...emoji, updatedAt: null }], keyAdvanceMs: 60000 },
 { id: 'profile-failure', names: ['alpha'], tags: [], rows: [emoji], profileFailure: true },
 { id: 'cache-failure', names: ['alpha'], tags: [], rows: [emoji], cacheFailure: true },
 { id: 'emoji-render-failure', names: ['alpha', 'beta'], tags: [], rows: [{ ...emoji, updatedAt: 'invalid' }, { ...emoji, name: 'beta', updatedAt: null }] },
 { id: 'hashtag-render-failure', names: ['alpha'], tags: ['\ud800'], rows: [{ ...emoji, updatedAt: null }] },
 { id: 'key-failure', names: ['alpha'], tags: [], rows: [{ ...emoji, updatedAt: null }], keyFailure: true },
];
for (const c of cases) {
 const events = [];
 let time = epoch;
 class Clock extends Date {
  constructor(...args) {
   if (args.length) { super(...args); } else { super(time); events.push({ op: 'clock', value: time }); time++; }
  }
 }
 const context = vm.createContext({ Date: Clock, URL });
 const methods = Object.fromEntries(Object.entries(methodText).map(([name, body]) => [name, vm.runInContext(ts.transpile(body, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)]));
 const all = new Map(c.rows.map(row => [row.name, { ...row, updatedAt: row.updatedAt === null ? null : new Date(row.updatedAt) }]));
 const receiver = {
  config: { url: 'https://local.test' },
  userEntityService: { genLocalUserUri: id => `https://local.test/users/${id}` },
  userProfilesRepository: { findOneByOrFail: async () => { events.push({ op: 'profile' }); if (c.profileFailure) throw Error('profile unavailable'); return { description: null, followedMessage: null, fields: [] }; } },
  customEmojiService: { localEmojisCache: { fetch: async () => { events.push({ op: 'emojis' }); if (c.cacheFailure) throw Error('emoji unavailable'); return all; } } },
  getEmojis: methods.getEmojis,
  renderEmoji(row) { events.push({ op: 'emoji', name: row.name }); return methods.renderEmoji.call(this, row); },
  renderHashtag(tag) { events.push({ op: 'hashtag', name: tag }); return methods.renderHashtag.call(this, tag); },
  userKeypairService: { getUserKeypair: async () => { events.push({ op: 'key' }); time += c.keyAdvanceMs ?? 0; if (c.keyFailure) throw Error('key unavailable'); return {}; } },
  renderKey: () => null, renderIdenticon: () => null,
 };
 try {
  const person = await methods.renderPerson.call(receiver, { id: 'local', username: 'alice', emojis: c.names, tags: c.tags });
  c.expected = { tag: JSON.parse(JSON.stringify(person.tag)), events };
 } catch (error) { c.expected = { error: { name: error.name, message: error.message }, events }; }
}
const result = { schemaVersion: 1, upstreamCommit, sourcePath, sourceSha256, methods: hashes, epoch, upstreamHttpMeasured: false,
 doubles: { profile: 'required findOneByOrFail, empty valid profile or throw', emojiCache: 'Map of plain rows or throw; no cache TTL/Redis measured', clock: 'Date subclass: zero-argument constructor samples epoch then advances 1ms; explicit date conversion uses native Date', key: 'empty key, optional 60000ms clock advance or throw; renderKey null', media: 'no avatar/banner; identicon null', uri: 'literal https://local.test/users/<id>', mfm: 'null description, no toHtml call' },
 exclusions: ['full actor equivalence', 'upstream HTTP/DB server', 'cache freshness and cache-hit DB failure behavior', 'malformed unrelated profile fields'], cases };
const output = JSON.stringify(result, null, 2) + '\n';
const target = new URL('./local-actor-tags-observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output); else assert.equal(readFileSync(target, 'utf8'), output);
console.log(`local actor tags source: ${cases.length} cases ${process.argv[2]}`);
