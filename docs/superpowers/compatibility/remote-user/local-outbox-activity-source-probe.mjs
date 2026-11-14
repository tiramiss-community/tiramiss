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
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { domainToASCII } from 'node:url';
// Fixture identities are the source of joined facts. Assertions on optional legacy
// facts make contradictions fail before an upstream method can consume them.
export function buildFixture(corpus, c) {
 const users = corpus.defaults.users.map(u => u.id === 'alice' ? { ...u, ...c.user } : { ...u });
 assert.equal(new Set(users.map(u => u.id)).size, users.length, 'duplicate user identity');
 const userById = new Map(users.map(u => [u.id, u]));
 const raw = c.dataset ? corpus.datasets[c.dataset] : [c.note ?? {}, ...(c.notes ?? [])];
 const notes = [...raw, ...(c.relatedNotes ?? [])].map(n => ({ ...corpus.defaults.note, ...n }));
 assert.equal(new Set(notes.map(n => n.id)).size, notes.length, 'duplicate Note identity');
 const byId = new Map(notes.map(n => [n.id, n]));
 const assertFacts = (declared, actual, label) => {
  if (declared === null) assert.equal(actual, null, label);
  else for (const [key, value] of Object.entries(declared)) assert.deepEqual(actual?.[key], value, `${label}.${key}`);
 };
 for (const n of notes) {
  const user = userById.get(n.userId) ?? null;
  assert.equal(n.userHost, user ? user.host : n.userHost, `${n.id}: userHost`);
  if ('user' in n) assertFacts(n.user, user, `${n.id}: user`);
  n.user = user;
 }
 for (const n of notes) {
  for (const relation of ['reply', 'renote']) {
   const target = byId.get(n[`${relation}Id`]) ?? null;
   if (relation in n) assertFacts(n[relation], target, `${n.id}: ${relation}`);
   n[relation] = target;
   for (const [suffix, value] of [['UserId', target?.userId ?? null], ['UserHost', target?.userHost ?? null]]) {
    const key = relation + suffix;
    // Missing targets are intentional failure fixtures, without invented joins.
    if (n[key] != null) assert.equal(n[key], value, `${n.id}: ${key}`);
    n[key] = value;
   }
  }
 }
 return { users, notes };
}

async function main() {
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert(['--write', '--check'].includes(process.argv[2]));
process.env.UPSTREAM_ROOT ??= '/tmp/tiramiss-relay171-upstream';
const require = createRequire(`${process.env.PROBE_HARNESS ?? '/tmp/tiramiss-s1-r13-probe'}/package.json`);
const upstreamRequire = createRequire(`${process.env.UPSTREAM_ROOT}/packages/backend/package.json`);
const ts = require('typescript');
const Fastify = require('fastify');
const fastifyAccepts = upstreamRequire('@fastify/accepts');
const accepts = upstreamRequire('accepts');
const vary = upstreamRequire('vary');
const mfm = upstreamRequire('mfm-js');
const { In, IsNull } = upstreamRequire('typeorm');
const sha = value => createHash('sha256').update(value).digest('hex');
const git = async (...args) => (await promisify(execFile)('git', ['-C', process.env.UPSTREAM_ROOT, ...args], { encoding: 'buffer', maxBuffer: 4000000 })).stdout;
const manifest = [];
const globals = { URL, In, IsNull, mfm, vary, fastifyAccepts, accepts };
const now = Date.parse('2026-11-03T12:00:00.000Z');
globals.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
async function source(path) {
 const bytes = await git('show', `${pin}:${path}`);
 const entry = { path, gitBlob: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), sha256: sha(bytes), methods: {} };
 manifest.push(entry);
 return { sf: ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true), entry };
}
function compile(node, sf, env = globals) {
 const literal = `(function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)})`;
 return vm.runInNewContext(ts.transpile(literal.replace('(function(', node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? '(async function(' : '(function('), { target: ts.ScriptTarget.ES2022 }), env);
}
async function methods(path, klass, names) {
 const { sf, entry } = await source(path);
 const members = klass ? sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === klass).members : sf.statements;
 const result = {};
 for (const name of names) {
  const node = members.find(n => n.name?.getText(sf) === name); assert(node, name);
  entry.methods[name] = sha(node.getText(sf)); result[name] = compile(node, sf);
 }
 return result;
}
Object.assign(globals, await methods('packages/backend/src/misc/escape-html.ts', null, ['escapeHtml']));
Object.assign(globals, await methods('packages/backend/src/misc/prelude/array.ts', null, ['concat','intersperse']));
// Functions compiled in separate VM contexts above need the literal concat binding.
globals.intersperse = (await methods('packages/backend/src/misc/prelude/array.ts', null, ['intersperse'])).intersperse;
const contextSource = await source('packages/backend/src/core/activitypub/misc/contexts.ts');
const contextExports = {};
vm.runInNewContext(ts.transpileModule(contextSource.sf.text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: contextExports });
globals.CONTEXT = contextExports.CONTEXT;
Object.assign(globals, await methods('packages/backend/src/misc/prelude/url.ts', null, ['query','appendQuery']));
const drive = await methods('packages/backend/src/core/entities/DriveFileEntityService.ts', 'DriveFileEntityService', ['getPublicUrl','getProxiedUrl']);
const html = await methods('packages/backend/src/core/MfmService.ts', 'MfmService', ['toHtml']);
const apMfm = await methods('packages/backend/src/core/activitypub/ApMfmService.ts', 'ApMfmService', ['getNoteHtml']);
const aidxSource = await source('packages/backend/src/misc/id/aidx.ts');
for (const name of ['TIME2000','TIME_LENGTH']) {
 const declaration = aidxSource.sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(aidxSource.sf) === name);
 globals[name] = vm.runInNewContext(declaration.initializer.getText(aidxSource.sf));
}
Object.assign(globals, await methods('packages/backend/src/misc/id/aidx.ts', null, ['parseAidx']));
const idService = await methods('packages/backend/src/core/IdService.ts','IdService',['parse']);
const renderer = await methods('packages/backend/src/core/activitypub/ApRendererService.ts', 'ApRendererService', ['renderNote','renderCreate','renderAnnounce','renderOrderedCollectionPage','renderDocument','renderEmoji','renderHashtag','renderMention','renderOrderedCollection','addContext','getEmojis']);
globals.domainToASCII = domainToASCII;
const utility = await methods('packages/backend/src/core/UtilityService.ts', 'UtilityService', ['isSelfHost','toPuny','isBlockedHost']);
const guardSrc = await source('packages/backend/src/server/ServerService.ts');
const serverPath = 'packages/backend/src/server/ActivityPubServerService.ts';
const serverSrc = await source(serverPath);
for (const name of ['ACTIVITY_JSON','LD_JSON']) {
 const node = serverSrc.sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(serverSrc.sf) === name);
 globals[name] = vm.runInNewContext(node.initializer.getText(serverSrc.sf));
}
const server = await methods(serverPath, 'ActivityPubServerService', ['setResponseType','packActivity','outbox','getUserNotesFromDb','createServer']);

Object.assign(globals, await methods('packages/backend/src/misc/is-renote.ts', null, ['isRenote','isQuote']));
Object.assign(globals, await methods('packages/backend/src/misc/prelude/array.ts', null, ['countIf']));
globals.url = await methods('packages/backend/src/misc/prelude/url.ts', null, ['query']);
globals.Brackets = upstreamRequire('typeorm').Brackets;
const pagination = await methods('packages/backend/src/core/QueryService.ts', 'QueryService', ['makePaginationQuery']);
const fanout = await methods('packages/backend/src/core/FanoutTimelineEndpointService.ts', 'FanoutTimelineEndpointService', ['getMiNotes','getAndFilterFromDb']);
const timeline = await methods('packages/backend/src/core/FanoutTimelineService.ts', 'FanoutTimelineService', ['getMulti']);
let rootOptions;
function walk(node) {
 if (ts.isCallExpression(node) && node.expression.getText(guardSrc.sf) === 'Fastify') rootOptions = node.arguments[0].getText(guardSrc.sf);
 ts.forEachChild(node, walk);
}
walk(guardSrc.sf); assert(rootOptions);
const corpusBytes = readFileSync(new URL('./local-outbox-activity-corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const observations = [];
const clean = value => JSON.parse(JSON.stringify(value));
for (const c of corpus.cases) {
 const events = [];
 const event = (...args) => events.push(clean(args));
 const note = { ...corpus.defaults.note, ...c.note };
 const { users, notes } = buildFixture(corpus, c);
 const render = { ...renderer, config: { url: corpus.defaults.selfUrl },
  notesRepository: { async findOneBy(where) { event('related-note', where); return notes.find(n => n.id === where.id) ?? null; } },
  usersRepository: { async exists({ where }) { event('author',where); return users.some(u => u.id === where.id); }, async findBy(where) { event('mentions'); return where.id._value.flatMap(id => users.filter(u => u.id === id)); } },
  driveFilesRepository: { async findBy(where) { event('files'); return (c.files ?? []).filter(f => where.id._value.includes(f.id)); } },
  pollsRepository: { async findOneBy() { event('poll'); return c.poll ? { ...c.poll, expiresAt: null } : null; } },
  customEmojiService: { localEmojisCache: { async fetch() { event('emoji'); return new Map((c.emojis ?? []).map(e => [e.name, { ...e, updatedAt: e.updatedAt ? new Date(e.updatedAt) : null }])); } } },
  userEntityService: { genLocalUserUri: id => `${corpus.defaults.selfUrl}/users/${id}`, getUserUri: u => u.host === null ? `${corpus.defaults.selfUrl}/users/${u.id}` : u.uri, isRemoteUser: u => u.host !== null },
  driveFileEntityService: { getPublicUrl: f => drive.getPublicUrl.call({ config:{ url:corpus.defaults.selfUrl, externalMediaProxyEnabled:false }, meta:{ proxyRemoteFiles:false }, getProxiedUrl:drive.getProxiedUrl }, f) },
  idService: { parse: id => idService.parse.call({ method:'aidx' }, id) },
  apMfmService: { getNoteHtml(n, extra) { event('html'); return apMfm.getNoteHtml.call({ mfmService: { toHtml: html.toHtml.bind({ config: { url: corpus.defaults.selfUrl } }) } }, n, extra); } },
 };
 // This finite QueryBuilder double records literal SQL predicates/order/limit. It is
 // not a PostgreSQL execution or a claim about database collation.
 function builder() {
  const clauses = []; let direction = 'DESC'; let limit = Infinity; let candidateIds;
  const q = { alias:'note',
   where(sql, params) { if (params?.noteIds) candidateIds = [...params.noteIds]; return q.andWhere(sql,params); },
   andWhere(sql, params) {
    if (typeof sql === 'string') { clauses.push([sql,params ?? null]); }
    else {
     const alternatives = [];
     const bracket = { where(text) { alternatives.push(text); return bracket; }, orWhere(text) { alternatives.push(text); return bracket; } };
     sql.whereFactory(bracket);
     clauses.push(['Brackets',alternatives]);
    }
    return q;
   },
   orderBy(column, order) { direction = order; return q; },
   limit(n) { limit = n; return q; },
   innerJoinAndSelect(path) { assert.equal(path, 'note.user'); return q; },
   leftJoinAndSelect(path) { assert(['note.reply','note.renote','reply.user','renote.user','note.channel'].includes(path)); return q; },
   async getMany() {
    if (c.fail === 'db') throw Error('DB unavailable (double)');
    event(candidateIds ? 'hydrate' : 'db', { clauses, direction, limit: Number.isFinite(limit) ? limit : null });
    let rows = notes.filter(n => candidateIds ? candidateIds.includes(n.id) && n.user !== null : clauses.every(([sql, ps]) => {
     if (ps?.sinceId !== undefined && !(n.id > ps.sinceId)) return false;
     if (ps?.untilId !== undefined && !(n.id < ps.untilId)) return false;
     if (ps?.userId !== undefined && n.userId !== ps.userId) return false;
     if (sql === 'Brackets' && !ps.some(text => text === `note.visibility = '${n.visibility}'`)) return false;
     if (sql === 'note.localOnly = FALSE' && n.localOnly) return false;
     return true;
    }));
    if (!candidateIds) rows = rows.sort((a,b) => direction === 'ASC' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id));
    return rows.slice(0,limit);
   },
  }; return q;
 }
 const service = { ...server, config: { ...render.config, host:'local.example' },
  meta: { federation:c.federation ?? 'all', allowExternalApRedirect:c.allowExternalApRedirect ?? true, enableFanoutTimeline:c.fanout ?? false, enableFanoutTimelineDbFallback:false, blockedHosts:['blocked.test'], ugcVisibilityForVisitor:c.visitor ?? 'all' },
  queryService:pagination,
  usersRepository: { async findOneBy(where) { if (c.fail == 'user') throw Error('user unavailable (double)'); event('user', { id:where.id, host:where.host._type }); return c.missing ? null : users.find(u => u.id === where.id && u.host === null) ?? null; } },
  notesRepository: {
   createQueryBuilder:builder,
   async findOneBy(where) { if (c.fail == 'root') throw Error('root unavailable (double)'); event('root', { id:where.id, userHost:where.userHost._type, visibility:where.visibility._value, localOnly:where.localOnly }); return c.missing ? null : notes.find(n => n.id === where.id && n.userHost === null && ['public','home'].includes(n.visibility) && !n.localOnly) ?? null; },
   async findOneByOrFail(where) { event('target',where); const n = notes.find(n => n.id === where.id); if (!n) throw Error('target missing (repository double)'); return n; },
  }, apRendererService:render,
 };
 const redis = { pipeline() {
  const keys = [];
  return { lrange(key,start,end) { keys.push([key,start,end]); return this; }, async exec() {
   event('redis',keys);
   if (c.redis === 'reject') throw Error('Redis unavailable (double)');
   if (c.redis === 'null') return null;
   if (c.redis === 'command-error') return [[Error('WRONGTYPE'),null],[null,[]]];
   return (c.lists ?? [[],[]]).map(ids => [null,[...ids]]);
  } };
 } };
 const endpoint = { ...fanout, meta:service.meta, notesRepository:service.notesRepository, utilityService:utility,
  fanoutTimelineService:{ getMulti:timeline.getMulti.bind({ redisForTimelines:redis }) } };
 service.fanoutTimelineEndpointService = { getMiNotes:async ps => {
  event('fanout-options',{ ...ps, noteFilter:'literal', dbFallback:'literal' });
  const fallback = ps.dbFallback;
  ps.dbFallback = async (...args) => { event('fallback',...args); return fallback(...args); };
  return endpoint.getMiNotes(ps);
 } };
 service.packActivity = server.packActivity.bind(service);
 const app = Fastify(vm.runInNewContext('(function(){return ' + rootOptions + '})').call({ config:{ trustProxy:false } }));
 const errors = [];
 app.addHook('onError', async (_request, _reply, error) => { errors.push({ name:error.name, message:error.message }); });
 try {
  await app.register(server.createServer.bind(service));
  const response = await app.inject({ method:c.method ?? 'GET', url:c.path ?? (c.route === 'activity' ? `/notes/${note.id}/activity` : '/users/alice/outbox') + (c.query ?? ''), headers:c.accept === null ? {} : { accept:c.accept ?? 'application/activity+json' } });
  const headers = Object.fromEntries(['cache-control','content-type','vary','location','access-control-allow-headers','access-control-allow-methods','access-control-allow-origin','access-control-expose-headers','link'].map(k => [k,response.headers[k] ?? null]));
  let body = response.body;
  if (body && response.statusCode >= 400 && headers['content-type']?.startsWith('application/json')) {
   const diagnostic = JSON.parse(body); body = { statusCode:diagnostic.statusCode, error:diagnostic.error };
  } else if (body && headers['content-type']?.includes('json')) { body = JSON.parse(body); }
  assert(!errors.some(e => e.name === 'ReferenceError'), `${c.id}: unresolved probe dependency`);
  assert.equal(response.statusCode >= 500, Boolean(c.id !== 'fanout-index-no-read' && (c.redis === 'reject' || c.redis === 'command-error' || c.fail || c.id.includes('announce-missing'))), `${c.id}: unexpected failure/success`);
  observations.push({ id:c.id, expected:{ status:response.statusCode, headers, body, events, errors } });
 } finally { await app.close(); }
}
function version(req, name) {
 let dir = dirname(req.resolve(name));
 while (!existsSync(join(dir,'package.json'))) dir = dirname(dir);
 return JSON.parse(readFileSync(join(dir,'package.json'))).version;
}
const dependencies = { node:process.version, ...Object.fromEntries(['fastify','typescript'].map(n => [n,version(require,n)])), ...Object.fromEntries(['accepts','@fastify/accepts','mfm-js','typeorm','vary'].map(n => [n,version(upstreamRequire,n)])) };
const result = { source:pin, dependencies, probeSha256:sha(readFileSync(new URL(import.meta.url))), manifest, corpusSha256:sha(corpusBytes), limits:corpus.limits, cases:observations };
const output = JSON.stringify(result,null,2)+'\n';
const target = new URL('./local-outbox-activity-observations.json',import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target,output); else assert.equal(readFileSync(target,'utf8'),output);
console.log(`local-outbox-activity literal source: ${observations.length} cases ${process.argv[2]} PASS`);

}
if (['--write', '--check'].includes(process.argv[2])) await main();
