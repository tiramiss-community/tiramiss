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

const root = new URL('../../../../', import.meta.url);
const require = createRequire(new URL('packages/backend-next/package.json', root));
const ts = require('typescript');
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? '/tmp/tiramiss-relay171-upstream';
const upstreamRequire = createRequire(`${upstream}/packages/backend/package.json`);
const Fastify = upstreamRequire('fastify');
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert.equal(corpus.upstreamRevision, pin);
const path = 'packages/backend/src/server/web/ClientServerService.ts';
const source = execFileSync('git', ['show', `${pin}:${path}`], { cwd: upstream });
const ast = ts.createSourceFile(path, source.toString(), ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'ClientServerService');
const method = name => service.members.find(node => node.name?.getText(ast) === name);
const routes = method('createServer').body.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'fastify.get' && ['/manifest.json', '/robots.txt', '/opensearch.xml'].includes(node.expression.arguments[0].text));
assert.equal(routes.length, 3);
const code = `export class Documents { meta; config;
${method('manifestHandler').getText(ast).replace('@bindThis', '')}
register(fastify) { ${routes.map(node => node.getText(ast)).join('\n')} }
}`;
const exports = {};
// Use the host JSON intrinsic so parse errors share Fastify's Error realm.
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, JSON });
const instance = new exports.Documents();
instance.config = corpus.config;
const app = Fastify();
instance.register(app);
await app.listen({ port: 0, host: '127.0.0.1' });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const cases = [];
try {
 for (const item of corpus.cases) {
  instance.meta = { ...corpus.defaults, ...item.meta };
  const responses = [];
  for (const path of ['/manifest.json', '/robots.txt', '/opensearch.xml']) {
   const response = await fetch(origin + path);
   responses.push({ path, status: response.status, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control'), body: await response.text() });
  }
  cases.push({ id: item.id, responses });
 }
} finally {
 await app.close();
}
const sha = value => createHash('sha256').update(value).digest('hex');
const output = JSON.stringify({ upstreamRevision: pin, corpusSha256: sha(corpusBytes), source: { path, sha256: sha(source) }, nodeVersion: process.version, fastifyVersion: upstreamRequire('fastify/package.json').version, observationKind: 'literal pinned manifest method and three route callbacks / real listening Fastify HTTP / explicit Meta snapshot; not full upstream application', cases }, null, 2) + '\n';
assert(['--write', '--check'].includes(process.argv[2]));
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') {
 writeFileSync(target, output);
} else {
 assert.equal(readFileSync(target, 'utf8'), output, 'public document source observations drift');
}
console.log(`${cases.length} cases / ${cases.length * 3} real HTTP requests ${process.argv[2]} PASS`);
