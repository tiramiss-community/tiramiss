/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { Ajv } = require('ajv');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT; assert(root); assert(['--write', '--check', '--pg'].includes(process.argv[2]));
const sha = x => createHash('sha256').update(x).digest('hex');
const manifest = [], modules = new Map();
const actual = new Set(['core/entities/PageEntityService.ts', 'server/api/endpoints/pages/show.ts', 'core/entities/DriveFileEntityService.ts', 'core/IdService.ts', 'decorators.ts', 'const.ts', 'misc/clone.ts', 'misc/bigint.ts', 'misc/is-mime-image.ts', 'misc/unique-by-key.ts', 'misc/prelude/await-all.ts', 'misc/prelude/url.ts', 'server/api/error.ts', ...['aid','aidx','meid','meidg','object-id','ulid'].map(x => `misc/id/${x}.ts`)]);
class Unused { constructor() { throw Error('unused source dependency instantiated'); } }
const stubbed = new Set(['core/UtilityService.ts','core/VideoProcessingService.ts','core/entities/UserEntityService.ts','core/entities/DriveFolderEntityService.ts']);
function load(relative) {
 if (modules.has(relative)) return modules.get(relative).exports;
 assert(actual.has(relative), `undeclared source dependency: ${relative}`);
 const file = `packages/backend/src/${relative}`;
 const bytes = execFileSync('git', ['-C', root, 'show', `${pin}:${file}`]);
 manifest.push({ path: file, sha256: sha(bytes), gitBlob: execFileSync('git', ['-C', root, 'rev-parse', `${pin}:${file}`]).toString().trim() });
 const module = { exports: {} }; modules.set(relative, module);
 const localRequire = specifier => {
  if (specifier === '@nestjs/common') return { Inject: () => () => {}, Injectable: () => () => {}, forwardRef: fn => fn };
  if (specifier === '@/di-symbols.js') return { DI: {} };
  if (specifier === '@/server/api/endpoint-base.js') return { Endpoint: class { constructor(meta, schema, handler) { Object.assign(this, {meta, schema, handler}); } } };
  if (specifier === 'nanoid') return { customAlphabet: (_alphabet, size) => () => '0'.repeat(size) };
  if (['typeorm','ulid','node:crypto'].includes(specifier)) return require(specifier);
  const resolved = (specifier.startsWith('@/') ? specifier.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))).replace(/\.js$/, '.ts');
  if (stubbed.has(resolved)) return { [path.basename(resolved, '.ts')]: Unused };
  return load(resolved);
 };
 const code = ts.transpileModule(bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, emitDecoratorMetadata: false } }).outputText;
 vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, Date, JSON, Object, Map, Set, Promise, Buffer, URL, Reflect, Symbol, console }, { filename: file });
 return module.exports;
}
// Bind the repository double's nullish filtering to the fixed database setup.
const databasePath = 'packages/backend/src/postgres.ts';
const databaseBytes = execFileSync('git', ['-C', root, 'show', `${pin}:${databasePath}`]);
manifest.push({ path: databasePath, sha256: sha(databaseBytes), gitBlob: execFileSync('git', ['-C', root, 'rev-parse', `${pin}:${databasePath}`]).toString().trim() });
const databaseSource = ts.createSourceFile(databasePath, databaseBytes.toString(), ts.ScriptTarget.Latest, true);
let invalidWhereValuesBehavior;
function readDatabaseOptions(node) {
 if (ts.isPropertyAssignment(node) && node.name.getText(databaseSource) === 'invalidWhereValuesBehavior') {
  invalidWhereValuesBehavior = JSON.parse(JSON.stringify(vm.runInNewContext(`(${node.initializer.getText(databaseSource)})`)));
 }
 ts.forEachChild(node, readDatabaseOptions);
}
readDatabaseOptions(databaseSource);
assert.deepEqual(invalidWhereValuesBehavior, {null:'ignore',undefined:'ignore'});
const { PageEntityService } = load('core/entities/PageEntityService.ts');
const { DriveFileEntityService } = load('core/entities/DriveFileEntityService.ts');
const { IdService } = load('core/IdService.ts');
const Endpoint = load('server/api/endpoints/pages/show.ts').default;
const bytes = readFileSync(new URL('corpus.json', import.meta.url)), corpus = JSON.parse(bytes);
const normalize = x => JSON.parse(JSON.stringify(x));
const matches = (row, where) => Object.entries(where).every(([key, value]) => value == null || row[key] === (value?._type === 'isNull' ? null : value));
const ajv = new Ajv({ useDefaults: true }); ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
if (process.argv[2] === '--pg') {
 const request = JSON.parse(readFileSync(0, 'utf8'));
 const { createDataSource } = await import(new URL('../../../../packages/backend-next/built/platform/database/data-source.js', import.meta.url));
 const database = createDataSource(request.database);
 database.setOptions({invalidWhereValuesBehavior});
 await database.initialize();
 try {
  const ids = new IdService({id:'aidx'});
  const users = {async pack(src) { const user = typeof src === 'string' ? await database.getRepository('user').findOneByOrFail({id:src}) : src; return {id:user.id,username:user.username}; }};
  const files = new DriveFileEntityService({url:'https://local',mediaProxy:'https://local/proxy',externalMediaProxyEnabled:false}, {proxyRemoteFiles:false}, database.getRepository('drive_file'), users, {}, {}, {}, ids);
  const pages = new PageEntityService(database.getRepository('page'), database.getRepository('page_like'), database.getRepository('drive_file'), users, files, ids);
  const endpoint = new Endpoint(database.getRepository('user'), database.getRepository('page'), pages);
  const results = [];
  for (const item of request.cases) {
   assert(ajv.compile(endpoint.schema)(item.input));
   results.push({id:item.id,result:normalize(await endpoint.handler(item.input,null))});
  }
  process.stdout.write(JSON.stringify(results));
 } finally { await database.destroy(); }
 process.exit(0);
}
const observations = [];
for (const c of corpus.cases) {
 const pages = structuredClone(corpus.pages).map(p => ({...p, updatedAt: new Date(p.updatedAt)}));
 if (c.missingEye) pages.find(p => p.id === c.input.pageId).eyeCatchingImageId = 'missing';
 const writes = [], pending = [], userCalls = [];
 const repository = {
  async findOneBy(where) { if(c.failRead) throw Error('page read failed'); return structuredClone(pages.find(p => matches(p,where)) ?? null); },
  async findOneByOrFail(where) { const p = await this.findOneBy(where); if (!p) throw Error('page missing'); return p; },
  update(id, patch) {
   const record = { id, content: normalize(patch.content), state: c.failWrite ? 'failed' : 'saved' }; writes.push(record);
   const promise = c.failWrite ? Promise.reject(Error('write failed')) : Promise.resolve().then(() => { pages.find(p => p.id === id).content = normalize(patch.content); });
   pending.push(promise.catch(() => {})); return promise.catch(() => {}); // Capture upstream's otherwise unhandled non-awaited rejection.
  },
 };
 const fileRepo = {
  async findOneBy(where) { return corpus.files.find(f => matches(f,where)) ?? null; },
  async findOneByOrFail(where) { const f = await this.findOneBy(where); if (!f) throw Error('file missing'); return f; },
 };
 const ids = new IdService({id:'aidx'});
 const users = { async pack(src, viewer, options) { userCalls.push({id:typeof src === 'string'?src:src.id,viewer:viewer?.id??null, options:options??null}); return {id:typeof src === 'string'?src:src.id,username:typeof src === 'string'?src:src.username}; }, async packMany(src, viewer) { return Promise.all(src.map(x => this.pack(x,viewer))); } };
 const files = new DriveFileEntityService({url:'https://local',mediaProxy:'https://local/proxy',externalMediaProxyEnabled:false}, {proxyRemoteFiles:false}, fileRepo, users, {}, {}, {}, ids);
 const page = new PageEntityService(repository, {async exists({where}) { return corpus.likes.some(x => matches(x,where)); }}, fileRepo, users, files, ids);
 const endpoint = new Endpoint({async findOneBy(where) { return corpus.users.find(u => matches(u,where))??null; }}, repository, page);
 const ps = structuredClone(c.input); let result, error;
 try { if (!ajv.compile(endpoint.schema)(ps)) error = {code:'INVALID_PARAM'}; else result = await endpoint.handler(ps,c.actor?{id:c.actor}:null); }
 catch(e) { assert.notEqual(e.name,'ReferenceError'); error = e.code ? {code:e.code,id:e.id,message:e.message} : {message:e.message}; }
 await Promise.all(pending);
 observations.push({id:c.id, expected:normalize({ ...(result === undefined?{}:{result}), ...(error?{error}:{}), writes, userCalls, ...(pages.some(p => p.id === c.input.pageId) ? { persistedContent: pages.find(p => p.id === c.input.pageId).content } : {}) })});
}
const output = JSON.stringify({upstreamCommit:pin, manifest, invalidWhereValuesBehavior, corpusSha256:sha(bytes), doubles:corpus.doubles, cases:observations},null,2)+'\n';
const target = new URL('observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output); else assert.equal(readFileSync(target,'utf8'),output);
console.log(`page-read imported source: ${observations.length} cases, ${manifest.length} source files ${process.argv[2]}`);
