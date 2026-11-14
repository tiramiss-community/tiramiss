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

const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const root = new URL('../../../../', import.meta.url);
const require = createRequire(new URL('packages/backend-next/package.json', root));
const ts = require('typescript');
const RE2 = require('re2');
const Fastify = createRequire(require.resolve('@misskey-dev/summaly'))('fastify');
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
assert.equal(corpus.upstreamRevision, pin);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [];
function source(path) {
 const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: root, maxBuffer: 4000000 });
 sources.push({ path, sha256: sha(bytes), gitBlob: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex') });
 return bytes.toString();
}
let clock = 0;
const DateAtClock = class extends Date { static now() { return clock; } };
const intervals = new Set();
function load(code, globals = {}) {
 const exports = {};
 const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
 vm.runInNewContext(javascript, { exports, Date: DateAtClock, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn), ...globals });
 return exports;
}
const cacheText = source('packages/backend/src/misc/cache.ts');
const { MemoryKVCache } = load(cacheText.slice(cacheText.indexOf('export class MemoryKVCache'), cacheText.indexOf('export class MemorySingleCache')).replace(/^\s*@bindThis\s*$/gm, ''));
const { ApiError } = load(source('packages/backend/src/server/api/error.ts'));
const { deepClone } = load(source('packages/backend/src/misc/clone.ts'));
const { query } = load(source('packages/backend/src/misc/prelude/url.ts'));
const utilityText = source('packages/backend/src/core/UtilityService.ts');
const utilityAst = ts.createSourceFile('UtilityService.ts', utilityText, ts.ScriptTarget.Latest, true);
const keywordMethod = utilityAst.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'UtilityService').members.find(node => node.name?.getText(utilityAst) === 'isKeyWordIncluded');
const { Keyword } = load(`export class Keyword { ${keywordMethod.getText(utilityAst).replace('@bindThis', '')} }`, { RE2 });
let currentStep;
let calls;
const result = () => {
 if (currentStep.fail) throw Error('injected acquisition failure');
 const value = structuredClone({ ...corpus.defaults.summary, ...currentStep.result });
 for (const key of currentStep.delete ?? []) delete value[key];
 return value;
};
const text = source('packages/backend/src/server/web/UrlPreviewService.ts');
// Replace only dependency loading. Every method body otherwise executes the pinned source.
assert.equal(text.split("await import('@misskey-dev/summaly')").length, 2);
const previewText = text.replace(/^import .+$/gm, '').replace(/^\s*@(bindThis|Injectable\(\)|Inject\(.+\))\s*$/gm, '').replace("await import('@misskey-dev/summaly')", 'await loadSummaly()');
const { UrlPreviewService } = load(previewText, { MemoryKVCache, ApiError, deepClone, query, _SUMMALY_VERSION_: '5.5.2', loadSummaly: async () => ({ summaly: async (url, options) => { calls.push({ mode: 'direct', url, options }); return result(); } }) });
const observations = [];
for (const item of corpus.cases) {
 clock = 0; calls = [];
 const settings = structuredClone(corpus.defaults.settings);
 const service = new UrlPreviewService({ url: corpus.defaults.url, mediaProxy: corpus.defaults.mediaProxy }, settings, {
  httpAgent: 'HTTP', httpsAgent: 'HTTPS',
  async getJson(url, accept, headers, allowLocalAddress) { calls.push({ mode: 'proxy', url, accept, headers, allowLocalAddress }); return result(); },
 }, new Keyword(), { getLogger: () => ({ info() {}, succ() {}, warn() {} }) });
 const app = Fastify(); app.get('/url', (request, reply) => service.handle(request, reply));
 const steps = [];
 try {
  for (const step of item.steps) {
   const before = calls.length;
   currentStep = step; clock += step.advance ?? 0;
   Object.assign(settings, step.settings ?? {});
   if (step.gc) for (const gc of intervals) gc();
   const response = await app.inject({ method: step.method ?? 'GET', url: step.path });
   const body = response.body ? JSON.parse(response.body) : '';
   steps.push({ status: response.statusCode, cacheControl: response.headers['cache-control'] ?? null, body, calls: structuredClone(calls.slice(before)) });
  }
  observations.push({ id: item.id, steps });
 } finally { service.dispose(); await app.close(); }
}
assert.equal(intervals.size, 0, 'source dispose releases all periodic cache timers');
const output = JSON.stringify({ upstreamRevision: pin, corpusSha256: sha(corpusBytes), sources, observationKind: 'pinned source methods / real Fastify parser / acquisition doubles / real RE2 / explicit clock without periodic advancement', cases: observations }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
assert(['--write', '--check'].includes(process.argv[2]));
if (process.argv[2] === '--write') writeFileSync(target, output);
else assert.equal(readFileSync(target, 'utf8'), output, 'source observations drift');
console.log(`${observations.length} cases / ${observations.reduce((n, item) => n + item.steps.length, 0)} requests ${process.argv[2]} PASS`);
