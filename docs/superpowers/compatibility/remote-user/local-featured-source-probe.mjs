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
import { domainToASCII } from 'node:url';
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert(['--write', '--check'].includes(process.argv[2]));
assert(process.env.UPSTREAM_ROOT, 'UPSTREAM_ROOT required');
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const upstreamRequire = createRequire(`${process.env.UPSTREAM_ROOT}/packages/backend/package.json`);
const ts = require('typescript');
const Fastify = upstreamRequire('fastify');
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
 const bytes = readFileSync(`${process.env.UPSTREAM_ROOT}/${path}`);
 assert.deepEqual(bytes, await git('show', `${pin}:${path}`), 'literal bytes equal pinned Git blob');
 const entry = { path, gitBlob: (await git('rev-parse', `${pin}:${path}`)).toString().trim(), sha256: sha(bytes), methods: {} };
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
const renderer = await methods('packages/backend/src/core/activitypub/ApRendererService.ts', 'ApRendererService', ['renderNote','renderDocument','renderEmoji','renderHashtag','renderMention','renderOrderedCollection','addContext','getEmojis']);
globals.domainToASCII = domainToASCII;
const utility = await methods('packages/backend/src/core/UtilityService.ts', 'UtilityService', ['isSelfHost','toPuny']);
const guardSrc = await source('packages/backend/src/server/ServerService.ts');
const launch = guardSrc.sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ServerService').members.find(n => n.name?.getText(guardSrc.sf) === 'launch');
const guard = launch.body.statements.find(n => ts.isIfStatement(n) && n.expression.getText(guardSrc.sf) === '!this.meta.allowExternalApRedirect');
assert(guard, 'literal redirect policy block');
guardSrc.entry.methods.externalApRedirectGuard = sha(guard.getText(guardSrc.sf));
const registerGuard = vm.runInNewContext(ts.transpile(`(function(fastify) { ${guard.getText(guardSrc.sf)} })`, { target:ts.ScriptTarget.ES2022 }), { process:{ env:{ NODE_ENV:'development' } } });
const productionGuard = vm.runInNewContext(ts.transpile(`(function(fastify) { ${guard.getText(guardSrc.sf)} })`, { target:ts.ScriptTarget.ES2022 }), { process:{ env:{ NODE_ENV:'production' } } });
const serverPath = 'packages/backend/src/server/ActivityPubServerService.ts';
const serverSrc = await source(serverPath);
for (const name of ['ACTIVITY_JSON','LD_JSON']) {
 const node = serverSrc.sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(serverSrc.sf) === name);
 globals[name] = vm.runInNewContext(node.initializer.getText(serverSrc.sf));
}
const server = await methods(serverPath, 'ActivityPubServerService', ['setResponseType','featured','createServer']);
const corpusBytes = readFileSync(new URL('./local-featured-corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const observations = [];
for (const c of corpus.cases) {
 const events = [];
 const event = stage => { events.push(stage); if (c.fail?.includes(stage)) throw Error(`${stage} unavailable`); };
 const note = { ...corpus.defaults.note, ...c.note };
 const notes = [note, ...(c.notes ?? [])];
 const users = corpus.defaults.users.map(u => u.id === 'alice' ? { ...u, ...c.user } : u);
 const reply = { ...renderer, config: { url: corpus.defaults.selfUrl },
  notesRepository: { async findOneBy(where) { const stage = notes.some(n => n.replyId === where.id) ? 'reply' : 'quote'; event(stage); return notes.find(n => n.id === where.id) ?? null; } },
  usersRepository: { async exists({ where }) { event('author'); return users.some(u => u.id === where.id); }, async findBy(where) { event('mentions'); return where.id._value.flatMap(id => users.filter(u => u.id === id)); } },
  driveFilesRepository: { async findBy(where) { event('files'); return (c.files ?? []).filter(f => where.id._value.includes(f.id)); } },
  pollsRepository: { async findOneBy() { event('poll'); return c.poll ? { ...c.poll, expiresAt: c.poll.expiresAt === null ? null : new Date(c.poll.expiresAt) } : null; } },
  customEmojiService: { localEmojisCache: { async fetch() { event('emoji'); return new Map((c.emojis ?? []).map(e => [e.name, { ...e, updatedAt: e.updatedAt ? new Date(e.updatedAt) : null }])); } } },
  userEntityService: { genLocalUserUri: id => `${corpus.defaults.selfUrl}/users/${id}`, getUserUri: u => u.host === null ? `${corpus.defaults.selfUrl}/users/${u.id}` : u.uri, isRemoteUser: u => u.host !== null },
  driveFileEntityService: { getPublicUrl: f => drive.getPublicUrl.call({ config:{ url:corpus.defaults.selfUrl, externalMediaProxyEnabled:false, ...c.config }, meta:{ proxyRemoteFiles:false }, getProxiedUrl:drive.getProxiedUrl }, f) },
  idService: { parse: id => idService.parse.call({ method:'aidx' }, id) },
  apMfmService: { getNoteHtml(n, extra) { event('html'); return apMfm.getNoteHtml.call({ mfmService: { toHtml: html.toHtml.bind({ config: { url: corpus.defaults.selfUrl } }) } }, n, extra); } },
 };
 if (c.route === 'render') {
  try { const result = await reply.renderNote(note, c.dive ?? true); observations.push({ id: c.id, expected: { json: JSON.parse(JSON.stringify(result)), events } }); }
  catch (e) { assert.notEqual(e.name,'ReferenceError', `${c.id}: undeclared oracle dependency`); observations.push({ id: c.id, expected: { error: { name: e.name, message: e.message }, events } }); }
  continue;
 }
 const receiver = { ...server, config: { ...reply.config, host:'local.example' }, meta: { federation: c.federation ?? 'all', allowExternalApRedirect:c.allowExternalApRedirect ?? true },
  usersRepository: { async findOneBy(where) { assert.deepEqual(Object.keys(where).sort(), ['host','id']); assert.equal(where.host._type,'isNull'); event('lookup'); return c.missing ? null : users.find(u => u.id === where.id && u.host === null) ?? null; } },
  userNotePiningsRepository: { async find(query) { assert.equal(query.order.id,'DESC'); assert.deepEqual(Object.keys(query).sort(),['order','where']); event('pins'); return [...(c.pins ?? [{ id:'1', noteId:note.id }])].sort((a,b) => b.id.localeCompare(a.id)); } },
  notesRepository: { async findOneBy(where) { event('lookup'); assert.equal(JSON.stringify(where.visibility._value),'["public","home"]'); assert.equal(where.localOnly,false); return c.missing || note.localOnly || !['public','home'].includes(note.visibility) ? null : note; }, async findOneByOrFail(where) { event('pin-note'); const found = notes.find(n => n.id === where.id); if (!found) throw Error('pinned note missing'); return found; } },
  apRendererService: reply, utilityService: { isSelfHost: host => utility.isSelfHost.call({ config:{ host:'local.example' }, toPuny:utility.toPuny },host) },
 };
 const app = Fastify();
 try {
  (c.production ? productionGuard : registerGuard).call(receiver, app);
  await app.register(server.createServer.bind(receiver));
  const response = await app.inject({ method: c.method ?? 'GET', url: (c.route === 'featured' ? '/users/alice/collections/featured' : `/notes/${note.id}`) + (c.query ?? ''), headers: { ...(c.accept === null ? {} : { accept: c.accept ?? 'application/activity+json' }) } });
  const headers = Object.fromEntries(['cache-control','content-type','vary','location','access-control-allow-headers','access-control-allow-methods','access-control-allow-origin','access-control-expose-headers','link'].map(k => [k,response.headers[k] ?? null]));
  if (response.statusCode === 500 && !c.fail?.length && !c.id.includes('broken-pin') && !['note-remote-null','note-remote-self'].includes(c.id)) throw Error(`${c.id}: unexpected source 500 ${response.body}`);
  const json = response.statusCode === 200 && c.method !== 'HEAD' ? JSON.parse(response.body) : null;
  observations.push({ id:c.id, expected: { status:response.statusCode, headers, json, bodyEmpty:response.body === '', ...(response.statusCode === 406 ? { text:response.body } : {}), events } });
 } finally { await app.close(); }
}
const result = { upstreamCommit:pin, manifest, corpusSha256:sha(corpusBytes), doubles:corpus.doubles, cases:observations };
const output = JSON.stringify(result,null,2)+'\n';
const target = new URL('./local-featured-observations.json',import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target,output); else assert.equal(readFileSync(target,'utf8'),output);
console.log(`local-featured source: ${observations.length} cases ${process.argv[2]}`);
