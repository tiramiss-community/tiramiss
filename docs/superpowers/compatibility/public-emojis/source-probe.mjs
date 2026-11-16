/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? '/tmp/tiramiss-relay171-upstream';
const root = new URL('../../../../', import.meta.url);
const require = createRequire(new URL('packages/backend-next/package.json', root));
const upstreamRequire = createRequire(`${upstream}/packages/backend/package.json`);
const ts = require('typescript');
const { DataSource, IsNull, In } = require('typeorm');
const { MiEmoji } = await import(new URL('packages/backend-upstream/built/exports/entities.js', root));
const Fastify = upstreamRequire('fastify');
const { Ajv } = require('ajv');
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const revision = '8e07cf085adf7009583d234a208e30436f020e26';
assert.equal(corpus.upstreamRevision, revision);
const paths = ['server/api/endpoints/emoji.ts', 'server/api/endpoints/emojis.ts', 'core/entities/EmojiEntityService.ts', 'server/api/ApiCallService.ts', 'core/CustomEmojiService.ts'];
const sources = paths.map(path => execFileSync('git', ['-C', upstream, 'show', `${revision}:packages/backend/src/${path}`], { encoding: 'utf8' }));
const ast = sources.map((source, i) => ts.createSourceFile(paths[i], source, ts.ScriptTarget.Latest, true));
const klass = index => ast[index].statements.find(ts.isClassDeclaration);
const member = (index, name) => klass(index).members.find(n => n.name?.getText(ast[index]) === name);
const compile = code => vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), { IsNull, In, Promise, JSON, Error });
const packer = {};
for (const name of ['packSimple', 'packDetailed', 'packSimpleMany']) {
 const node = member(2, name);
 packer[name] = compile(`(async function(${node.parameters.map(p => p.getText(ast[2])).join(',')})${node.body.getText(ast[2])})`).bind(packer);
}
const config = { type: 'postgres', host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55304), username: 'postgres', password: 'foundation-test-only', database: 'backend_next_test' };
const admin = new DataSource(config);
await admin.initialize();
const database = `emoji_source_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${database}"`);
const db = new DataSource({ ...config, database, entities: [MiEmoji] });
const app = Fastify();
const observations = [];
const prefetch = [];
try {
 await db.initialize();
 // The fixed Emoji entity has no relation dependencies. This isolated source database
 // contains only its ordinary table; production migrations are exercised by next tests.
 await db.synchronize();
 await db.getRepository(MiEmoji).insert(corpus.rows);
 packer.emojisRepository = db.getRepository(MiEmoji);
 const invalid = error => ({ message: 'Invalid param.', code: 'INVALID_PARAM', id: '3d81ceae-475f-4600-b2a8-2bc116157532', kind: 'client', info: { param: error.schemaPath, reason: error.message } });
 const internal = error => ({ message: 'Internal error occurred. Please contact us if the error persists.', code: 'INTERNAL_ERROR', id: '5d37dbcb-891e-41ca-a3d6-e690c97775ac', kind: 'server', info: { e: { message: error.message, code: error.name } } });
 const authError = { message: 'Authentication failed. Please ensure your token is correct.', code: 'AUTHENTICATION_FAILED', id: 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14', kind: 'client' };
 const service = { telemetryService: { startSpan: (_name, callback) => callback() }, authenticateService: { authenticate: async token => { if (token != null && token !== 'validtoken123456') throw authError; return [token ? { id: 'viewer' } : null, null]; } }, logIp() {}, send: (reply, value) => reply.send(value) };
 // Keep the source handleRequest cache/token policy literal, with an explicit
 // authentication double and equivalent error serializer around the endpoint.
 const handle = member(3, 'handleRequest');
 const handleText = handle.body.getText(ast[3]).replaceAll('this.#sendApiError', 'this.sendError').replaceAll('this.#sendAuthenticationError', 'this.sendError');
 service.handle = compile(`(function(${handle.parameters.map(p => p.getText(ast[3])).join(',')})${handleText})`);
 service.sendError = (reply, error) => reply.code(error.code === 'INVALID_PARAM' ? 400 : error.code === 'AUTHENTICATION_FAILED' ? 401 : 500).send({ error });
 for (let index = 0; index < 2; index++) {
  const endpoint = index === 0 ? 'emoji' : 'emojis';
  const constructor = klass(index).members.find(ts.isConstructorDeclaration);
  const superCall = constructor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression;
  const literal = superCall.arguments[2];
  const callback = compile(`(async function(${literal.parameters.map(p => p.getText(ast[index])).join(',')})${literal.body.getText(ast[index])})`).bind({ emojisRepository: db.getRepository(MiEmoji), emojiEntityService: packer });
  const param = ast[index].statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations[0].name.getText(ast[index]) === 'paramDef').declarationList.declarations[0].initializer;
  const validate = new Ajv({ useDefaults: true }).compile(compile(`(${param.getText(ast[index])})`));
  const ep = { name: endpoint, meta: { cacheSec: 3600 } };
  service.call = async (_ep, _user, _app, body) => {
   if (!validate(body)) throw invalid(validate.errors[0]);
   try { return await callback(body); } catch (error) { throw internal(error); }
  };
  // Capture the per-endpoint call because both routes share the source instance.
  const call = service.call;
  app.all('/api/' + endpoint, async (request, reply) => {
   reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
   const scoped = { ...service, call };
   await service.handle.call(scoped, ep, request, reply);
   return reply;
  });
 }
 await app.listen({ port: 0, host: '127.0.0.1' });
 const origin = `http://127.0.0.1:${app.server.address().port}`;
 for (const item of corpus.cases) {
  const response = await fetch(origin + item.path, { method: item.method, headers: { ...(item.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...item.headers }, ...(item.body === undefined ? {} : { body: JSON.stringify(item.body) }) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (body?.error?.info?.e) {
   // Error UUIDs are runtime-generated; compare the exposed error class instead.
   delete body.error.info.e.message;
  }
  observations.push({ id: item.id, status: response.status, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control'), body });
 }
 const prefetchMethod = member(4, 'prefetchEmojis');
 const prefetchLiteral = compile(`(async function(${prefetchMethod.parameters.map(p => p.getText(ast[4])).join(',')})${prefetchMethod.body.getText(ast[4])})`);
 const cache = new Map([['remote remote.test', { name: 'remote', host: 'remote.test', publicUrl: 'https://stale.test/remote' }], ['missing remote.test', null]]);
 const state = { emojisRepository: db.getRepository(MiEmoji), emojisCache: cache };
 const requests = [{ name: 'remote', host: 'remote.test' }, { name: 'missing', host: 'remote.test' }, { name: 'plain', host: null }];
 await prefetchLiteral.call(state, requests);
 prefetch.push({ id: 'prefetch-preserves-positive-and-absent-negative', urls: [...cache].map(([key, row]) => [key, row?.publicUrl ?? null]) });
 await db.getRepository(MiEmoji).insert({ ...corpus.rows[3], id: 'missing', name: 'missing', publicUrl: 'https://new.test/missing' });
 await prefetchLiteral.call(state, requests);
 prefetch.push({ id: 'prefetch-rereads-negative-after-insert', urls: [...cache].map(([key, row]) => [key, row?.publicUrl ?? null]) });
 assert.equal(cache.get('missing remote.test').publicUrl, 'https://new.test/missing');
 assert.equal(cache.has('plain null'), false);

} finally {
 await app.close();
 if (db.isInitialized) await db.destroy();
 await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
 await admin.destroy();
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(observations[0].status, 200);
assert.deepEqual(observations[0].body.emojis.map(row => row.name), ['aaa', 'restricted', 'plain', 'plain%ZZ']);
assert.equal(observations[2].body.name, 'plain');
const result = { upstreamRevision: revision, corpusSha256: sha(corpusBytes), source: Object.fromEntries(paths.map((path, i) => [path, sha(sources[i])])), scope: 'literal endpoint callbacks, packSimple/Many/packDetailed and handleRequest; real TypeORM/PostgreSQL and listening Fastify plus literal prefetch with explicit Map cache; explicit auth/error wrapper, not full upstream server', cases: observations, prefetch };
const target = new URL('./observations.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(target, JSON.stringify(result, null, 2) + '\n'); else assert.deepEqual(result, JSON.parse(readFileSync(target, 'utf8')));
console.log(`PASS: ${observations.length} pinned public emoji HTTP/PostgreSQL observations / ${prefetch.length} prefetch observations`);
