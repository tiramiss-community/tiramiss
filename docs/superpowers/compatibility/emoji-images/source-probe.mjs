/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { request } from 'node:http';
import vm from 'node:vm';

const root = new URL('../../../../', import.meta.url);
const require = createRequire(new URL('packages/backend-next/package.json', root));
const ts = require('typescript');
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? '/tmp/tiramiss-relay171-upstream';
const upstreamRequire = createRequire(process.env.BACKEND_NEXT_SOURCE_DEPENDENCIES ?? `${upstream}/packages/backend/package.json`);
const corpusBytes = await readFile(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert.equal(corpus.upstreamRevision, pin);
const manifest = JSON.parse(execFileSync('git', ['show', `${pin}:packages/backend/package.json`], { cwd: upstream }));
for (const [name, version] of Object.entries({ '@fastify/static': '10.1.5', fastify: '5.12.5', sharp: '0.35.5', '@misskey-dev/emoji-assets': '17.0.3' })) {
 assert.equal(manifest.dependencies[name], version);
}
const path = 'packages/backend/src/server/web/ClientServerService.ts';
const source = execFileSync('git', ['show', `${pin}:${path}`], { cwd: upstream });
const ast = ts.createSourceFile(path, source.toString(), ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'ClientServerService');
const method = service.members.find(node => node.name?.getText(ast) === 'createServer');
const routes = method.body.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'fastify.get' && ['/fluent-emoji/:path(.*)', '/twemoji/:path(.*)', '/twemoji-badge/:path(.*)'].includes(node.expression.arguments[0].text));
assert.equal(routes.length, 3);
const ms = upstreamRequire('ms').default;
assert.equal(ms('30 days'), 2592000000);
const code = `export class Images { fluentEmojiDir; twemojiDir; register(fastify) { ${routes.map(node => node.getText(ast)).join('\n')} } }`;
const exports = {};
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, sharp: require('sharp'), ms });
const instance = new exports.Images();
const assets = await mkdtemp(join(tmpdir(), 'emoji-images-source-'));
instance.fluentEmojiDir = join(assets, 'fluent-emoji');
instance.twemojiDir = join(assets, 'twemoji');
const packageAssets = dirname(dirname(require.resolve('@misskey-dev/emoji-assets/twemoji/1f600.svg')));
const sha = value => createHash('sha256').update(value).digest('hex');
const inputs = [];
let badgeMetadata;
for (const [directory, name] of [['fluent-emoji', '1f600.png'], ['twemoji', '1f600.svg']]) {
 await mkdir(join(assets, directory), { recursive: true });
 await copyFile(join(packageAssets, directory, name), join(assets, directory, name));
 await utimes(join(assets, directory, name), 946684800, 946684800);
 inputs.push({ path: `${directory}/${name}`, sha256: sha(await readFile(join(assets, directory, name))) });
}
await writeFile(join(assets, 'twemoji/1f601.svg'), 'invalid svg');
const app = upstreamRequire('fastify')();
await app.register(upstreamRequire('@fastify/static'), { root: assets, serve: false });
instance.register(app);
await app.listen({ port: 0, host: '127.0.0.1' });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const cases = [];
try {
 for (const item of corpus.cases) {
  const response = await new Promise((resolve, reject) => {
   const req = request(origin + item.path, { method: item.method, headers: item.headers }, async res => {
    const chunks = [];
    for await (const chunk of res) { chunks.push(chunk); }
    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
   });
   req.on('error', reject);
   req.end();
  });
  const body = response.body;
  if (item.id === 'badge') {
   const metadata = await require('sharp')(body).metadata();
   badgeMetadata = { width: metadata.width, height: metadata.height, format: metadata.format };
  }
  const headers = Object.fromEntries(['content-type', 'cache-control', 'content-security-policy', 'content-length', 'etag', 'last-modified', 'accept-ranges', 'content-range'].map(name => [name, response.headers[name] ?? null]));
  if (['missing-badge', 'badge-error-head'].includes(item.id)) {
   headers['content-length'] = String(Number(headers['content-length']) - assets.length + '<assets>'.length);
  }
  const binary = headers['content-type']?.startsWith('image/');
  cases.push({ id: item.id, status: response.status, headers, ...(binary ? { bodySha256: sha(body) } : { body: body.toString().replaceAll(assets, '<assets>') }) });
 }
} finally {
 await app.close();
 await rm(assets, { recursive: true, force: true });
}
for (const [id, status] of Object.entries({ fluent: 200, twemoji: 200, badge: 200, 'missing-fluent': 404, 'missing-twemoji': 404, 'missing-badge': 500, 'corrupt-badge': 500, range: 206, 'range-invalid': 416, 'not-modified': 304, 'if-none-match': 304, precondition: 412, 'fluent-emoji-bare': 404, 'twemoji-bare': 404, 'twemoji-badge-bare': 404, 'fluent-emoji-encoded-prefix': 200, 'twemoji-encoded-prefix': 200, 'twemoji-badge-encoded-prefix': 200, 'fluent-emoji-bad-nested': 400, 'twemoji-bad-nested': 400, 'twemoji-badge-bad-nested': 400 })) {
 assert.equal(cases.find(item => item.id === id).status, status, `source harness smoke: ${id}`);
}
assert.deepEqual(badgeMetadata, { width: 512, height: 512, format: 'png' });
const output = JSON.stringify({ upstreamRevision: pin, corpusSha256: sha(corpusBytes), source: { path, sha256: sha(source) }, nodeVersion: process.version, fastifyVersion: upstreamRequire('fastify/package.json').version, sharpVersion: require('sharp').versions.sharp, staticVersion: upstreamRequire('@fastify/static/package.json').version, assetVersion: JSON.parse(await readFile(join(packageAssets, '../package.json'), 'utf8')).version, sendVersion: createRequire(upstreamRequire.resolve('@fastify/static'))('@fastify/send/package.json').version, badgeMetadata, observationKind: 'literal three pinned route callbacks; real listening Fastify/static/Sharp; controlled actual package images and corrupt/missing file; not full upstream application', inputs, cases }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
assert(['--write', '--check'].includes(process.argv[2]));
if (process.argv[2] === '--write') {
 await writeFile(target, output);
} else {
 assert.equal(await readFile(target, 'utf8'), output, 'emoji image source observations drift');
}
console.log(`${cases.length} real HTTP observations ${process.argv[2]} PASS`);
