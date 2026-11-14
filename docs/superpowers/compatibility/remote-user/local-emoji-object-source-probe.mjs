/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert(['--write', '--check'].includes(process.argv[2]));
const upstream = process.env.UPSTREAM_ROOT ?? '/tmp/tiramiss-relay171-upstream';
const require = createRequire(`${process.env.PROBE_HARNESS ?? '/tmp/tiramiss-s1-r13-probe'}/package.json`);
const sourceRequire = createRequire(`${upstream}/packages/backend/package.json`);
const ts = require('typescript');
const Fastify = require('fastify');
const fastifyAccepts = sourceRequire('@fastify/accepts');
const accepts = sourceRequire('accepts');
const { IsNull } = sourceRequire('typeorm');
const sha = value => createHash('sha256').update(value).digest('hex');
const corpusBytes = readFileSync(new URL('./local-emoji-object-corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
assert.equal(corpus.source, pin);
const manifest = [];
function source(path) {
 const bytes = execFileSync('git', ['-C', upstream, 'show', `${pin}:${path}`], { maxBuffer: 4000000 });
 const entry = { path, gitBlob: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), sha256: sha(bytes), methods: {} };
 manifest.push(entry);
 return { sf: ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true), entry };
}
const clock = Date.parse(corpus.defaults.now);
const FixedDate = class extends Date {
 constructor(...args) { super(...(args.length ? args : [clock])); }
 static now() { return clock; }
};
const env = { IsNull, fastifyAccepts, accepts, Date: FixedDate };
function methods(path, klass, names) {
 const { sf, entry } = source(path);
 const members = sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === klass).members;
 return Object.fromEntries(names.map(name => {
  const node = members.find(n => n.name?.getText(sf) === name);
  assert(node, name);
  entry.methods[name] = sha(node.getText(sf));
  const literal = `(${node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)})`;
  return [name, vm.runInNewContext(ts.transpile(literal, { target: ts.ScriptTarget.ES2022 }), env)];
 }));
}
const context = source('packages/backend/src/core/activitypub/misc/contexts.ts');
const exports = {};
vm.runInNewContext(ts.transpileModule(context.sf.text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports });
env.CONTEXT = exports.CONTEXT;
const renderer = methods('packages/backend/src/core/activitypub/ApRendererService.ts', 'ApRendererService', ['renderEmoji', 'addContext']);
const serverText = source('packages/backend/src/server/ActivityPubServerService.ts');
for (const name of ['ACTIVITY_JSON', 'LD_JSON']) {
 const node = serverText.sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(serverText.sf) === name);
 env[name] = vm.runInNewContext(node.initializer.getText(serverText.sf));
}
const serverMethods = methods('packages/backend/src/server/ActivityPubServerService.ts', 'ActivityPubServerService', ['setResponseType', 'createServer']);
const root = source('packages/backend/src/server/ServerService.ts');
let rootOptions;
function walk(node) {
 if (ts.isCallExpression(node) && node.expression.getText(root.sf) === 'Fastify') rootOptions = node.arguments[0].getText(root.sf);
 ts.forEachChild(node, walk);
}
walk(root.sf);
assert(rootOptions);
const observations = [];
for (const c of corpus.cases) {
 const rows = (c.rows ?? [{ ...corpus.defaults.emoji, ...c.emoji }, ...(c.extraRows ?? []).map(row => ({ ...corpus.defaults.emoji, ...row }))]);
 const before = JSON.stringify(rows);
 const events = [];
 const errors = [];
 const service = { ...serverMethods, meta: { federation: c.federation ?? 'all' },
  emojisRepository: { async findOneBy(where) {
   events.push(['emoji', { name: where.name, host: where.host._type }]);
   if (c.fail === 'db') throw Error('injected repository diagnostic');
   const row = rows.find(row => row.name === where.name && row.host === null);
   return row ? { ...row, updatedAt: row.updatedAt === null ? null : new Date(row.updatedAt) } : null;
  } },
  apRendererService: { ...renderer, config: { url: corpus.defaults.selfUrl } },
 };
 const app = Fastify(vm.runInNewContext(`(function(){return ${rootOptions}})`).call({ config: { trustProxy: false } }));
 app.addHook('onError', async (_request, _reply, error) => errors.push({ name: error.name, message: error.message }));
 try {
  await app.register(serverMethods.createServer.bind(service));
  const response = await app.inject({ method: c.method ?? 'GET', url: (c.path ?? '/emojis/hello') + (c.query ?? ''), headers: c.accept === null ? {} : { accept: c.accept ?? 'application/activity+json' } });
  const headers = Object.fromEntries(['cache-control', 'content-type', 'vary', 'location', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin', 'access-control-expose-headers'].map(key => [key, response.headers[key] ?? null]));
  let body = response.body;
  if (body && headers['content-type']?.includes('json')) {
   body = JSON.parse(body);
   if (response.statusCode >= 400) body = { statusCode: body.statusCode, error: body.error };
  }
  assert(!errors.some(error => error.name === 'ReferenceError'), `${c.id}: unresolved dependency`);
  assert.equal(response.statusCode >= 500, c.id === 'invalid-date' || c.fail === 'db' && c.federation !== 'none', `${c.id}: unexpected failure`);
  assert.equal(JSON.stringify(rows), before, `${c.id}: repository state changed`);
  observations.push({ id: c.id, expected: { status: response.statusCode, headers, body, events, errors, unchanged: true } });
 } finally { await app.close(); }
}
function version(req, name) {
 let directory = dirname(req.resolve(name));
 while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
 return JSON.parse(readFileSync(join(directory, 'package.json'))).version;
}
const result = { source: pin, dependencies: { node: process.version, fastify: require('fastify/package.json').version, typescript: ts.version, accepts: sourceRequire('accepts/package.json').version, typeorm: version(sourceRequire, 'typeorm') }, probeSha256: sha(readFileSync(new URL(import.meta.url))), corpusSha256: sha(corpusBytes), manifest, limits: corpus.limits, cases: observations };
const output = JSON.stringify(result, null, 2) + '\n';
const target = new URL('./local-emoji-object-observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output);
else assert.equal(readFileSync(target, 'utf8'), output);
console.log(`local-emoji-object literal source: ${observations.length} cases ${process.argv[2]} PASS`);
