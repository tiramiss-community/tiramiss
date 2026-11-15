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
const root = process.env.BACKEND_NEXT_UPSTREAM_PATH;
assert(root, 'Set BACKEND_NEXT_UPSTREAM_PATH to a checkout with pinned Git objects');
const path = 'packages/backend/src/core/MetaService.ts';
const source = execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8' });
const ts = createRequire(new URL('../../../../package.json', import.meta.url))('typescript');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const members = ast.statements.find(ts.isClassDeclaration).members;
let tick; let cleared = false; let listener; let reads = 0; let rows = [{ id: 'a', name: 'old' }, { id: 'z', name: 'new' }]; let failure; let gate;
const sandbox = { MiMeta: class {}, process: { env: {} }, setInterval: (callback, delay) => { assert.equal(delay, 300000); tick = callback; return 1; }, clearInterval: () => { cleared = true; } };
function extract(name, ctor = false) {
 const node = members.find(n => ctor ? ts.isConstructorDeclaration(n) : n.name?.getText(ast) === name);
 return vm.runInNewContext(ts.transpile(`(${ctor || name === 'dispose' ? '' : 'async '}function(${ctor ? '' : node.parameters.map(p => p.getText(ast)).join(',')}) ${node.body.getText(ast)})`, { target: ts.ScriptTarget.ES2022 }), sandbox);
}
const fetch = extract('fetch'); const receive = extract('onMessage'); const dispose = extract('dispose');
const state = { db: { transaction: async work => work({ find: async () => { reads++; const snapshot = structuredClone(rows).sort((a,b) => b.id.localeCompare(a.id)); if (gate) {
 await gate;
} if (failure) {
 throw new Error('database unavailable');
} return snapshot; }, upsert: async (_, value) => { if (!rows.length) {
 rows.push(value);
} return { identifiers: [{ id: 'x' }] }; }, findOneByOrFail: async () => rows[0] }) }, redisForSub: { on: (_, callback) => { listener = callback; }, off: (_, callback) => { assert.equal(callback, listener); listener = undefined; } } };
state.fetch = fetch.bind(state); state.onMessage = receive.bind(state);
extract('', true).call(state);
const observations = [];
const observe = async id => observations.push({ id, cache: JSON.parse(JSON.stringify(await state.fetch())), reads });
await observe('newest-id'); rows = [{ id: 'z', name: 'database' }]; await observe('cache-hit');
await state.fetch(true); await observe('no-cache');
await state.onMessage('source.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { before: { name: 'before' }, after: { id: 'z', name: 'event', rootUser: { id: 'joined' } } } } })); await observe('notification-after');
await state.onMessage('source.test', JSON.stringify({ channel: 'internal', message: { type: 'other', body: { after: { name: 'ignored' } } } })); await observe('unrelated-event');
let release; gate = new Promise(resolve => { release = resolve; }); const pending = state.fetch(true);
await state.onMessage('source.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { after: { id: 'z', name: 'racing-event' } } } }));
release(); await pending; gate = undefined; await observe('fetch-overwrites-notification');
failure = true; await assert.rejects(state.fetch(true), /database unavailable/); failure = false; await observe('failed-read-retains-cache');
rows = [{ id: 'z', name: 'periodic' }]; tick(); await new Promise(resolve => setTimeout(resolve, 0)); await observe('periodic-reload');
rows = []; state.cache = undefined; await observe('empty-initialization');
dispose.call(state); assert(cleared); assert.equal(listener, undefined);
const result = { upstreamRevision: revision, input: { path, sha256: createHash('sha256').update(source).digest('hex') }, methodExtraction: 'literal constructor/fetch/onMessage/dispose with transactional repository, pubsub and timer doubles; not full upstream server or PostgreSQL', observations, stop: { timerCleared: cleared, listenerRemoved: listener === undefined }, limitations: ['in-flight fetch can overwrite a newer event', 'source periodic rejection is unhandled; new implementation reports it', 'source dispose does not wait for in-flight reads; new process shutdown drains them'] };
const output = new URL('./observations.json', import.meta.url);
if (process.argv.includes('--write')) {
 writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
} else {
 assert.deepEqual(result, JSON.parse(readFileSync(output, 'utf8')));
}
console.log(`PASS: ${observations.length} pinned MetaService observations and stop`);
