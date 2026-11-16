/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const revision = '8e07cf085adf7009583d234a208e30436f020e26';
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH;
assert(upstream, 'BACKEND_NEXT_UPSTREAM_PATH required');
const ts = createRequire(new URL('../../../../package.json', import.meta.url))('typescript');
const paths = ['misc/cache.ts', 'core/CustomEmojiService.ts', 'core/activitypub/models/ApNoteService.ts'];
const source = paths.map(path => execFileSync('git', ['-C', upstream, 'show', `${revision}:packages/backend/src/${path}`], { encoding: 'utf8' }));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let time = 0, gc;
class Clock extends Date { static now() { return time; } }
const context = vm.createContext({ Date: Clock, setInterval(callback, ms) { assert.equal(ms, 180000); gc = callback; return 1; }, clearInterval() {}, Map, JSON, Math });
const literal = source[0].replace(/^import .*;$/gm, '').replaceAll('@bindThis', '').replaceAll('export class', 'class');
vm.runInContext(ts.transpile(literal + '\nglobalThis.caches = { MemoryKVCache, RedisSingleCache };', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context);
const sf = ts.createSourceFile(paths[1], source[1], ts.ScriptTarget.Latest, true);
const klass = sf.statements.find(n => ts.isClassDeclaration(n));
const extract = name => { const node = klass.members.find(n => n.name?.getText(sf) === name); return vm.runInContext(ts.transpile(`(async function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)})`, { target: ts.ScriptTarget.ES2022 }), context); };
const observations = [];
let rows = [{ name: 'wave', updatedAt: new Date(1000), publicUrl: 'https://old.test/wave', originalUrl: 'https://original.test/wave' }], unavailable = false, reads = 0;
const store = new Map();
const redis = { async get(key) { return store.get(key) ?? null; }, async set(key, value, mode, seconds) { assert.equal(key, 'singlecache:localEmojis'); assert.deepEqual([mode, seconds], ['EX', 1800]); store.set(key, value); } };
context.IsNull = () => null;
const state = { redisClient: redis, emojisRepository: { async find() { reads++; if (unavailable) throw Error('database stopped'); return rows.map(r => ({ ...r })); }, async findOneBy({ name }) { reads++; if (unavailable) throw Error('database stopped'); return rows.find(row => row.name === name) ?? null; } } };
const ctor = klass.members.find(ts.isConstructorDeclaration);
vm.runInContext(ts.transpile(`(function()${ctor.body.getText(sf)})`, { target: ts.ScriptTarget.ES2022 }), context).call(state);
const local = state.localEmojisCache;
const observeLocal = async id => observations.push({ id, values: [...(await local.fetch()).values()].map(row => ({ url: row.publicUrl, updatedAtMs: row.updatedAt?.getTime() ?? null })), reads });
await observeLocal('local-cold'); unavailable = true; time = 180000; await observeLocal('local-exact-boundary');
time = 180001; await observeLocal('local-redis-date-revival');
store.clear(); time = 360002; await assert.rejects(local.fetch(), /database stopped/); observations.push({ id: 'local-expired-db-failure', reads });
unavailable = false; rows = []; await observeLocal('local-deleted');
const remote = state.emojisCache;
state.parseEmojiStr = (value, host) => { const match = value.match(/^([-\w]+)(?:@([\w.-]+))?$/); return { name: match?.[1] ?? null, host: match?.[2] === '.' || match?.[2] === 'local.test' ? null : match?.[2] ?? host }; };
const populate = extract('populateEmoji').bind(state);
time = 0; rows = [{ name: 'wave', publicUrl: 'https://old.test/wave', originalUrl: 'https://original.test/wave' }];
const observeRemote = async id => observations.push({ id, values: await Promise.all(['wave', 'missing', 'wave@.', 'invalid:name'].map(name => populate(name, 'remote.test'))), reads });
await observeRemote('remote-cold-positive-negative'); unavailable = true; await observeRemote('remote-hit-db-stopped'); unavailable = false;
rows = [{ name: 'wave', publicUrl: 'https://new.test/wave', originalUrl: 'https://original.test/wave' }, { name: 'missing', publicUrl: '', originalUrl: 'https://original.test/missing' }];
time = 43200000; await observeRemote('remote-exact-boundary-still-stale'); time++; await observeRemote('remote-expired-refresh');
time += 43200000; rows = []; gc(); await observeRemote('remote-gc-exact-boundary-deleted'); remote.dispose();
// extractEmojis writes through the repository directly and has no URL cache hook.
const ap = ts.createSourceFile(paths[2], source[2], ts.ScriptTarget.Latest, true);
const extraction = ap.statements.find(n => ts.isClassDeclaration(n)).members.find(n => n.name?.getText(ap) === 'extractEmojis').getText(ap);
assert(!/emojisCache|populateEmoji|localEmojisCache|\.invalidate\(/.test(extraction));
const result = { revision, source: Object.fromEntries(paths.map((path, i) => [path, sha(source[i])])), literalMethodSha256: { populateEmoji: sha(klass.members.find(n => n.name?.getText(sf) === 'populateEmoji').getText(sf)), extractEmojis: sha(extraction) }, scope: 'literal cache classes and populateEmoji; explicit repository/Redis/clock doubles, not full upstream HTTP/PG', observations };
const output = new URL('./observations.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); else assert.deepEqual(result, JSON.parse(readFileSync(output, 'utf8')));
console.log(`PASS: ${observations.length} pinned actor emoji cache observations`);
