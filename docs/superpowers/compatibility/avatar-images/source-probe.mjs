/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import vm from 'node:vm';

const root = new URL('../../../../', import.meta.url);
const require = createRequire(new URL('packages/backend-next/package.json', root));
const ts = require('typescript');
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? '/tmp/tiramiss-relay171-upstream';
const sourceRequire = createRequire(process.env.BACKEND_NEXT_SOURCE_DEPENDENCIES ?? '/tmp/emoji-images-555-source-deps/package.json');
const corpusBytes = await readFile(new URL('corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
assert.equal(new Set(corpus.cases.map(item => item.id)).size, corpus.cases.length, 'image corpus IDs must be unique');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const manifest = JSON.parse(execFileSync('git', ['show', `${pin}:packages/backend/package.json`], { cwd: upstream }));
for (const [name, version] of Object.entries({ fastify: '5.12.5', '@napi-rs/canvas': '1.0.10', 'random-seed': '0.3.0' })) assert.equal(manifest.dependencies[name], version);
assert.equal(sourceRequire('fastify/package.json').version, manifest.dependencies.fastify);
assert.equal(require('@napi-rs/canvas/package.json').version, manifest.dependencies['@napi-rs/canvas']);
assert.equal(require('random-seed/package.json').version, manifest.dependencies['random-seed']);
assert.equal(corpus.upstreamRevision, pin);
const sha = value => createHash('sha256').update(value).digest('hex');
const inputs = [];
function source(path) {
 const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: upstream });
 inputs.push({ path, sha256: sha(bytes) });
 return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function load(code, globals = {}) {
 const exports = {};
 vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, ...globals });
 return exports;
}
const renderer = source('packages/backend/src/misc/gen-identicon.ts');
assert(renderer.text.includes("import { createCanvas } from '@napi-rs/canvas';"));
assert(renderer.text.includes("import gen from 'random-seed';"));
const { genIdenticon } = load(renderer.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(renderer)).join('\n'), { createCanvas: require('@napi-rs/canvas').createCanvas, gen: require('random-seed') });
const acct = source('packages/backend/src/misc/acct.ts');
const Acct = load(acct.text);
const entity = source('packages/backend/src/core/entities/UserEntityService.ts');
const entityClass = entity.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'UserEntityService');
const getter = entityClass.members.find(node => node.name?.getText(entity) === 'getIdenticonUrl');
const server = source('packages/backend/src/server/ServerService.ts');
assert(server.text.includes("import * as Acct from '@/misc/acct.js';"), 'use the Acct module actually imported by ServerService');
assert(server.text.includes("import { genIdenticon } from '@/misc/gen-identicon.js';"));
assert(server.text.includes("import { UserEntityService } from '@/core/entities/UserEntityService.js';"));
assert(server.text.includes("import Fastify, { type FastifyInstance } from 'fastify';"));
assert(server.text.includes("import { IsNull } from 'typeorm';"));
const service = server.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'ServerService');
const method = service.members.find(node => node.name?.getText(server) === 'launch');
const routes = method.body.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(server) === 'fastify.get' && ['/emoji/:path(.*)', '/avatar/@:acct', '/identicon/:x'].includes(node.expression.arguments[0].text));
assert.equal(routes.length, 3);
const { Images } = load(`export class Images { config; meta; emojisRepository; usersRepository; userEntityService; getIdenticonUrl(user) ${getter.body.getText(entity)} register(fastify) { ${routes.map(node => node.getText(server)).join('\n')} } }`, { Acct, IsNull: () => null, URL, genIdenticon: seed => seed === 'failure' ? Promise.reject(new Error('identicon generation failed')) : genIdenticon(seed) });
const instance = new Images();
instance.config = corpus.config;
instance.meta = corpus.meta;
instance.userEntityService = instance;
instance.emojisRepository = { async findOneBy({ name, host }) {
 if (name === 'fail') throw new Error('emoji lookup failed');
 return corpus.emojis.find(emoji => emoji.name === name && emoji.host === host) ?? null;
} };
instance.usersRepository = { async findOne({ where }) {
 if (where.usernameLower === 'fail') throw new Error('avatar lookup failed');
 return corpus.users.find(user => user.username.toLowerCase() === where.usernameLower && user.host === where.host && !user.isSuspended) ?? null;
} };
const app = sourceRequire('fastify')();
instance.register(app);
await app.listen({ port: 0, host: '127.0.0.1' });
const cases = [];
try {
 for (const item of corpus.cases) {
  instance.config = { ...corpus.config, ...(item.mediaProxy ? { mediaProxy: item.mediaProxy } : {}) };
  instance.meta = { ...corpus.meta, ...item.meta };
  const response = await new Promise((resolve, reject) => {
   const req = request({ hostname: '127.0.0.1', port: app.server.address().port, path: item.path, method: item.method }, async res => {
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
   });
   req.on('error', reject); req.end();
  });
  const headers = Object.fromEntries(['content-type', 'cache-control', 'content-security-policy', 'location', 'content-length'].map(name => [name, response.headers[name] ?? null]));
  const binary = response.status === 200 && headers['content-type'] === 'image/png' && item.method !== 'HEAD';
  cases.push({ id: item.id, status: response.status, headers, ...(binary ? { bodySha256: sha(response.body), metadata: await require('sharp')(response.body).metadata().then(({ width, height, format }) => ({ width, height, format })) } : { body: response.body.toString() }) });
 }
} finally { await app.close(); }
assert.equal(new Set(cases.map(item => item.id)).size, cases.length, 'image observation IDs must be unique');
for (const [id, status] of Object.entries({ local: 301, avatar: 302, 'seed-alice@local.test': 200, disabled: 302, 'database-failure': 500, 'too-many-at': 400 })) assert.equal(cases.find(item => item.id === id).status, status);
for (const item of cases.filter(item => item.metadata)) assert.deepEqual(item.metadata, { width: 128, height: 128, format: 'png' });
const output = JSON.stringify({ upstreamRevision: pin, observationKind: 'literal pinned ServerService callbacks, UserEntityService.getIdenticonUrl, Acct.parse and genIdenticon; controlled repository/Meta doubles and injected generation failure, real listening Fastify/native canvas; not full upstream application or upstream PostgreSQL', corpusSha256: sha(corpusBytes), nodeVersion: process.version, fastifyVersion: sourceRequire('fastify/package.json').version, canvasVersion: require('@napi-rs/canvas/package.json').version, randomSeedVersion: require('random-seed/package.json').version, inputs, cases }, null, 2) + '\n';
assert(['--write', '--check'].includes(process.argv[2]));
if (process.argv[2] === '--write') await writeFile(new URL('observations.json', import.meta.url), output);
else assert.equal(await readFile(new URL('observations.json', import.meta.url), 'utf8'), output, 'avatar images source observations drift');
console.log(`${cases.length} fixed-source HTTP observations ${process.argv[2]} PASS`);
