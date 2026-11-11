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
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const manifest = [
 { path: 'packages/backend/src/server/WellKnownServerService.ts', klass: 'WellKnownServerService', sha256: 'a95eae39e0a03afa7ace1c9902394923f753ee4ba578783b15bc2ddc40a38d02', methods: { createServer: '3625e950ebfe8d55bdd65546488d009286b42f7d734af41baa90e70389663cea' } },
 { path: 'packages/backend/src/misc/acct.ts', sha256: 'c1ceb56ab1f159d2a8261ac57c0c5f8b20330505a16dc08e572f30a15140e49d', methods: { parse: '26d9ba7a3eb16ee5f663857a05b77d5f8c3b4f63ddd2552acc05a6e2600e6d7f' } },
 { path: 'packages/backend/src/misc/prelude/xml.ts', sha256: '43e37baa00eb7c9d3a84d1484c0b5be84a33a5fe70bbdeaada27bb868e45eb9c', methods: { escapeValue: '9cb4114e3ae0a2ccf19b1436a019a0ccf1614744b831c612191163e8aaa3a804', escapeAttribute: '80ed0208690e32882f95397776db1fbf6a49edf3c538f817466a618edcaacb19' } },
];
assert(['--write', '--check'].includes(process.argv[2]));
assert(process.env.UPSTREAM_ROOT, 'UPSTREAM_ROOT required');
const sha = value => createHash('sha256').update(value).digest('hex');
const git = async (...args) => (await promisify(execFile)('git', ['-C', process.env.UPSTREAM_ROOT, ...args], { encoding: 'buffer' })).stdout;
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const upstreamRequire = createRequire(`${process.env.UPSTREAM_ROOT}/packages/backend/package.json`);
const ts = require('typescript');
const Fastify = upstreamRequire('fastify');
const fastifyAccepts = upstreamRequire('@fastify/accepts');
const vary = upstreamRequire('vary');
const { IsNull } = upstreamRequire('typeorm');
const sources = {};
for (const entry of manifest) {
 const bytes = readFileSync(`${process.env.UPSTREAM_ROOT}/${entry.path}`);
 assert.equal(sha(bytes), entry.sha256, 'complete source SHA256');
 assert.deepEqual(bytes, await git('show', `${pin}:${entry.path}`), 'checkout equals pinned Git bytes');
 entry.gitBlob = (await git('rev-parse', `${pin}:${entry.path}`)).toString().trim();
 const sf = ts.createSourceFile(entry.path, bytes.toString(), ts.ScriptTarget.Latest, true);
 const members = entry.klass ? sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === entry.klass).members : sf.statements;
 for (const [name, fingerprint] of Object.entries(entry.methods)) {
  assert.equal(sha(members.find(n => n.name?.getText(sf) === name).getText(sf)), fingerprint, `literal ${name}`);
 }
 sources[entry.path] = { sf, members, bytes };
}
function literalModule(path) {
 const exports = {};
 vm.runInNewContext(ts.transpileModule(sources[path].bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports });
 return exports;
}
const Acct = literalModule(manifest[1].path);
const xml = literalModule(manifest[2].path);
const method = sources[manifest[0].path].members.find(n => n.name?.getText() === 'createServer');
const expression = `(function(${method.parameters.map(p => p.getText()).join(',')})${method.body.getText()})`;
const createServer = vm.runInNewContext(ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { IsNull, vary, fastifyAccepts, Acct, ...xml, URL });
const corpusBytes = readFileSync(new URL('./local-webfinger-corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
assert.equal(corpus.upstreamCommit, pin);
const cors = {
 'access-control-allow-headers': 'Accept', 'access-control-allow-methods': 'GET, OPTIONS',
 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Vary',
};
const observations = [];
for (const c of corpus.cases) {
 const lookups = [];
 const row = { ...corpus.defaults.row, ...c.row };
 const receiver = {
  config: { url: corpus.defaults.selfUrl, host: new URL(corpus.defaults.selfUrl).host },
  meta: { federation: c.federation ?? 'all' },
  usersRepository: { async findOneBy(where) {
   assert.equal(where.host._type, 'isNull'); assert.equal(where.isSuspended, false);
   assert.deepEqual(Object.keys(where).sort(), ['host', 'isSuspended', 'id' in where ? 'id' : 'usernameLower'].sort(), 'no deleted predicate or other lookup');
   const query = 'id' in where ? { id: where.id } : { usernameLower: where.usernameLower };
   lookups.push(query);
   if (c.fail) throw Error('database unavailable');
   if (row.host !== null || row.isSuspended) return null;
   return ('id' in query ? query.id === row.id : query.usernameLower === 'alice') ? row : null;
  } },
  userEntityService: { genLocalUserUri: id => `${corpus.defaults.selfUrl}/users/${id}` },
  nodeinfoServerService: { getLinks() { throw Error('unexpected NodeInfo'); } },
  oauth2ProviderService: { generateRFC8414() { throw Error('unexpected OAuth'); } },
 };
 const app = Fastify();
 try {
  await app.register(createServer.bind(receiver));
  const query = c.queryString ?? (c.resource === null ? '' : `resource=${encodeURIComponent(c.resource)}`);
  const response = await app.inject({ method: c.method ?? 'GET', url: `/.well-known/webfinger?${query}`, headers: c.accept ? { accept: c.accept } : {} });
  assert.equal(response.statusCode, c.expected.status, c.id);
  assert.deepEqual(lookups, c.expected.query === null ? [] : [c.expected.query], `${c.id} lookup`);
  for (const [key, value] of Object.entries(cors)) assert.equal(response.headers[key], value, `${c.id} ${key}`);
  const success = c.expected.status === 200;
  assert.equal(response.headers.vary ?? null, success ? 'Accept' : null, `${c.id} vary`);
  assert.equal(response.headers['cache-control'] ?? null, success ? 'public, max-age=180' : null, `${c.id} cache`);
  if (success) assert.equal(response.headers['content-type'], c.expected.format === 'xrd' ? 'application/xrd+xml' : 'application/jrd+json; charset=utf-8', `${c.id} type`);
  const body = !success ? null : c.method === 'HEAD' ? '' : c.expected.format === 'jrd' ? JSON.parse(response.body) : response.body;
  const expectedBody = c.method === 'HEAD' ? '' : c.expected.body ?? corpus.defaults[c.expected.format];
  if (success) assert.deepEqual(body, expectedBody, `${c.id} body`);
  if (c.method === 'HEAD' || c.expected.status === 204) assert.equal(response.body, '', `${c.id} empty body`);
  observations.push({ id: c.id, status: response.statusCode, lookups, headers: Object.fromEntries([...Object.keys(cors), 'vary', 'cache-control', 'content-type'].map(key => [key, response.headers[key] ?? null])), body });
 } finally { await app.close(); }
}
const result = { schemaVersion: 1, upstreamCommit: pin, corpusSha256: sha(corpusBytes), manifest,
 evidence: 'literal pinned createServer with actual Fastify inject and installed accepts; literal Acct/XML modules; not upstream full-server/PG',
 doubles: { meta: 'fixed injected federation; notification/cache behavior not tested', repository: 'where predicates asserted; explicit plain row/missing/throw; no PG', uriService: 'genLocalUserUri(id) maps explicit config URL + /users/id', nodeinfoAndOAuth: 'throw if unexpectedly invoked' },
 errorBodyScope: 'non-200 bodies normalized to null; Fastify diagnostic error JSON is not the public compatibility contract', cases: observations };
const output = JSON.stringify(result, null, 2) + '\n';
const target = new URL('./local-webfinger-observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output); else assert.equal(readFileSync(target, 'utf8'), output);
console.log(`local WebFinger source: ${observations.length} directly asserted cases ${process.argv[2]}; pinned Git bytes + function fingerprints; actual Fastify inject`);
