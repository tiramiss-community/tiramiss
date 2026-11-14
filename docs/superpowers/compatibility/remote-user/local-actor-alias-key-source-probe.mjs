/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { domainToASCII } from 'node:url';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
function version(name) { let dir = dirname(req.resolve(name)); while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir); return JSON.parse(readFileSync(join(dir, 'package.json'))).version; }
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const req = createRequire(`${process.env.PROBE_HARNESS ?? '/tmp/tiramiss-s1-r13-probe'}/package.json`);
const up = createRequire(`${process.env.UPSTREAM_ROOT ?? '/tmp/tiramiss-relay171-upstream'}/packages/backend/package.json`);
const ts = req('typescript');
const Fastify = req('fastify');
const globals = { URL, domainToASCII, createPublicKey, accepts: req('accepts'), fastifyAccepts: req('@fastify/accepts'), vary: up('vary'), IsNull: req('typeorm').IsNull,
 ACTIVITY_JSON: 'application/activity+json; charset=utf-8', LD_JSON: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8' };
const hash = x => createHash('sha256').update(x).digest('hex');
const manifest = [];
const git = async (...args) => (await promisify(execFile)('git', args, { maxBuffer: 4000000 })).stdout;
async function source(path) {
 const text = await git('show', `${pin}:${path}`);
 manifest.push({ path, blob: (await git('rev-parse', `${pin}:${path}`)).trim(), sha256: hash(text) });
 return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}
function compile(node, sf) {
 const literal = `(${node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)})`;
 return vm.runInNewContext(ts.transpile(literal, { target: ts.ScriptTarget.ES2022 }), globals);
}
async function methods(path, klass, names) {
 const sf = await source(path);
 const members = klass ? sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === klass).members : sf.statements;
 return Object.fromEntries(names.map(name => { const n = members.find(n => n.name?.getText(sf) === name); assert(n, name); return [name, compile(n, sf)]; }));
}
globals.Acct = await methods('packages/backend/src/misc/acct.ts', null, ['parse', 'toString']);
const utility = await methods('packages/backend/src/core/UtilityService.ts', 'UtilityService', ['toPuny','isSelfHost']);
const context = await source('packages/backend/src/core/activitypub/misc/contexts.ts');
const exports = {};
vm.runInNewContext(ts.transpileModule(context.text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
globals.CONTEXT = exports.CONTEXT;
const renderer = await methods('packages/backend/src/core/activitypub/ApRendererService.ts', 'ApRendererService', ['renderKey','addContext']);
const api = await methods('packages/backend/src/server/ActivityPubServerService.ts', 'ActivityPubServerService', ['createServer','userInfo','setResponseType']);
const server = await source('packages/backend/src/server/ServerService.ts');
let guard;
let rootOptions;
function walk(node) {
 if (ts.isCallExpression(node) && node.expression.getText(server) === 'Fastify') rootOptions = node.arguments[0].getText(server);
 if (ts.isIfStatement(node) && node.expression.getText(server) === '!this.meta.allowExternalApRedirect') guard = node;
 ts.forEachChild(node, walk);
}
walk(server); assert(guard); assert(rootOptions);
const guardLiteral = `(function(fastify){${guard.getText(server)}})`;
const corpus = JSON.parse(readFileSync(new URL('./local-actor-alias-key-corpus.json', import.meta.url)));
// Public fixture only; no private key is persisted or needed for renderer conversion.
const keyFixture = JSON.parse(readFileSync(new URL('./local-actor-alias-key-key.json', import.meta.url)));
const results = [];
for (const c of corpus.cases) {
 const selfUrl = c.selfUrl ?? 'https://local.test';
 const calls = [];
 const user = { id: 'local', username: 'Alice', host: c.kind === 'remote' || c.path.includes('remote.test') || c.path.includes('REMOTE.test') ? 'remote.test' : null, uri: c.uri ?? 'https://remote.test/actor' };
 if (c.kind === 'null-uri' || c.kind === 'empty-uri' || c.kind === 'self-row') { user.host = c.kind === 'self-row' ? 'local.test' : 'remote.test'; user.uri = c.kind === 'null-uri' ? null : c.kind === 'empty-uri' ? '' : user.uri; }
 const render = { ...renderer, config: { url: selfUrl }, userEntityService: { genLocalUserUri: id => `${selfUrl}/users/${id}` }, renderPerson: async u => {
  calls.push(['person', u.id]);
  const key = await service.userKeypairService.getUserKeypair(u.id);
  return { type: 'Person', id: `${selfUrl}/users/${u.id}`, publicKey: render.renderKey(u, key, '#main-key') };
 } };
 const service = { ...api, config: { host: new URL(selfUrl).host }, meta: { federation: c.federation ?? 'all', allowExternalApRedirect: c.allow ?? true },
  utilityService: { ...utility, config: { host: new URL(selfUrl).host } }, apRendererService: render,
  userEntityService: { isLocalUser: u => u.host === null },
  usersRepository: { findOneBy: async q => {
   const query = { ...q, ...(q.host?._type === 'isNull' ? { host: null } : {}) }; calls.push(['lookup',query]);
   if (c.kind === 'missing' || (q.isSuspended === false && c.kind === 'suspended') || ('id' in q && (q.id !== 'local' || user.host !== null))) return null;
   return user;
  } },
  userKeypairService: { getUserKeypair: async id => { calls.push(['key',id]); if (c.kind === 'key-missing') throw Error('missing key'); return { publicKey: c.kind === 'key-invalid' ? 'invalid' : keyFixture.pkcs1 }; } },
 };
 const fastify = Fastify(vm.runInNewContext('(function(){return ' + rootOptions + '})').call({ config: { trustProxy: false } }));
 const installGuard = vm.runInNewContext(ts.transpile(guardLiteral), { process: { env: { NODE_ENV: c.production === false ? 'test' : 'production' } }, encodeURI });
 installGuard.call(service, fastify);
 await fastify.register((scope, options, done) => service.createServer(scope, options, done));
 const response = await fastify.inject({ url: c.path, method: c.method ?? 'GET', headers: c.accept === '' ? {} : { accept: c.accept ?? 'application/activity+json' } });
 const headers = Object.fromEntries(['content-type','cache-control','vary','location','link','access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-expose-headers'].map(k => [k, response.headers[k] ?? null]));
 let body = response.body;
 // Diagnostics identify framework errors, but framework/version-specific message text is outside this finite comparison.
 if (response.body && response.statusCode >= 400 && headers['content-type']?.startsWith('application/json')) { const error = JSON.parse(body); body = JSON.stringify({ statusCode: error.statusCode, error: error.error }); }
 results.push({ id: c.id, status: response.statusCode, headers, body, calls });
 await fastify.close();
}
const acct = ['', '@', '@@alice', 'Alice@', 'Alice@REMOTE.test@ignored', ' Alice ', 'a%40b'].map(input => ({ input, parsed: globals.Acct.parse(input), formatted: globals.Acct.toString(globals.Acct.parse(input)) }));
const key = [undefined, '', '#main-key'].map(postfix => ({ postfix: postfix ?? null, output: renderer.renderKey.call({ config: { url: 'https://local.test' }, userEntityService: { genLocalUserUri: id => `https://local.test/users/${id}` } }, { id: 'local' }, { publicKey: keyFixture.pkcs1 }, postfix) }));
const observed = { source: pin, manifest, dependencies: Object.fromEntries(['fastify','@fastify/accepts','accepts','typescript','typeorm'].map(n => [n, version(n)])), limits: 'Literal Git methods + real Fastify inject; repository/key acquisition/person dependencies are doubles. Person compared by key/id projection. No full upstream server/PG/cache equivalence. Framework diagnostic message text excluded; empty vs exception bodies retained.', acct, key, cases: results };
const target = new URL('./local-actor-alias-key-observations.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(target, JSON.stringify(observed, null, 2)+'\n');
else assert.deepEqual(JSON.parse(JSON.stringify(observed)), JSON.parse(readFileSync(target)));
console.log(`source ${results.length} routes + ${acct.length} acct + ${key.length} key: PASS`);
