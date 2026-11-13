/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert(['--write', '--check'].includes(process.argv[2]));
assert(process.env.UPSTREAM_ROOT, 'UPSTREAM_ROOT required');
// A separate pinned dependency harness can be used without installing into the read-only source checkout.
const require = createRequire(process.env.FOLLOW_PROBE_PACKAGE ?? `${process.env.UPSTREAM_ROOT}/packages/backend/package.json`);
const ts = require('typescript');
const Fastify = require('fastify');
const { IsNull, LessThan } = require('typeorm');
const globals = { IsNull, LessThan, fastifyAccepts: require('@fastify/accepts'), accepts: require('accepts') };
const sha = value => createHash('sha256').update(value).digest('hex');
const fastifyRequire = createRequire(require.resolve('fastify'));
const routerRequire = createRequire(fastifyRequire.resolve('find-my-way'));
const queryRequire = createRequire(routerRequire.resolve('fast-querystring'));
const queryParser = {
 fastQuerystring: {version:queryRequire('../package.json').version,parseSha256:sha(readFileSync(queryRequire.resolve('./parse')))},
 fastDecodeUriComponent: {version:queryRequire('fast-decode-uri-component/package.json').version,sha256:sha(readFileSync(queryRequire.resolve('fast-decode-uri-component')))},
};
assert.equal(queryParser.fastQuerystring.version,'1.1.2');
assert.equal(queryParser.fastDecodeUriComponent.version,'1.0.1');
const manifest = [];
async function source(path) {
 const bytes = readFileSync(`${process.env.UPSTREAM_ROOT}/${path}`);
 const git = (...args) => promisify(execFile)('git', ['-C',process.env.UPSTREAM_ROOT,...args], { encoding: 'buffer', maxBuffer: 4000000 }).then(r => r.stdout);
 assert.deepEqual(bytes, await git('show', `${pin}:${path}`));
 const entry = { path, gitBlob: (await git('rev-parse', `${pin}:${path}`)).toString().trim(), sha256:sha(bytes), methods:{} };
 manifest.push(entry);
 return { sf:ts.createSourceFile(path,bytes.toString(),ts.ScriptTarget.Latest,true), entry };
}
async function methods(path, klass, names) {
 const {sf,entry} = await source(path);
 const members = klass ? sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === klass).members : sf.statements;
 return Object.fromEntries(names.map(name => {
  const node = members.find(n => n.name?.getText(sf) === name && n.body); assert(node,name);
  entry.methods[name] = sha(node.getText(sf));
  const async = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  const literal = `(${async}function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)})`;
  return [name,vm.runInNewContext(ts.transpile(literal,{target:ts.ScriptTarget.ES2022}),globals)];
 }));
}
const context = await source('packages/backend/src/core/activitypub/misc/contexts.ts');
const exports = {};
vm.runInNewContext(ts.transpileModule(context.sf.text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports});
globals.CONTEXT = exports.CONTEXT;
globals.url = await methods('packages/backend/src/misc/prelude/url.ts',null,['query']);
const serverSource = await source('packages/backend/src/server/ActivityPubServerService.ts');
for (const name of ['ACTIVITY_JSON','LD_JSON']) {
 const n = serverSource.sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(serverSource.sf) === name);
 globals[name] = vm.runInNewContext(n.initializer.getText(serverSource.sf));
}
const server = await methods('packages/backend/src/server/ActivityPubServerService.ts','ActivityPubServerService',['followers','following','setResponseType','createServer']);
const renderer = await methods('packages/backend/src/core/activitypub/ApRendererService.ts','ApRendererService',['renderFollowUser','renderOrderedCollection','renderOrderedCollectionPage','addContext']);
Object.assign(globals, await methods('packages/backend/src/core/entities/UserEntityService.ts',null,['isLocalUser']));
const predicates = await methods('packages/backend/src/core/entities/UserEntityService.ts',null,['isRemoteUser']);
const userService = {...await methods('packages/backend/src/core/entities/UserEntityService.ts','UserEntityService',['getUserUri','genLocalUserUri']),...predicates};
const corpusBytes = readFileSync(new URL('./local-follow-collections-corpus.json',import.meta.url));
const corpus = JSON.parse(corpusBytes);
const cases = [];
for (const c of corpus.cases) {
 const events = [];
 const relationCursors = [];
 const lookupIds = [];
 let metaEntries = 0;
 const event = s => { events.push(s); if (c.fail === s) throw Error(`${s} unavailable`); };
 const size = c.size ?? corpus.defaults.size;
 const rows = Array.from({length:size},(_,i) => { const n=String(i+1).padStart(3,'0'); return {id:`r${n}`,followerId:c.direction==='followers'?`u${n}`:'alice',followeeId:c.direction==='following'?`u${n}`:'alice'}; });
 const userEntityService = {...userService,config:{url:corpus.defaults.selfUrl}};
 const apRendererService = {...renderer,userEntityService,usersRepository:{async findOneByOrFail({id}) {
  event(`member:${id}`);
  if (c.missingMember) throw Error('member missing');
  return {id,host:Number(id.slice(1))%2 ? 'remote.test':null,uri:c.nullMember?null:`https://remote.test/${id}`};
 }}};
 const receiver = {...server,config:{url:corpus.defaults.selfUrl},meta:{get federation() {metaEntries++;return c.federation??'all';}},apRendererService,
  usersRepository:{async findOneBy(where) { assert.equal(where.host._type,'isNull'); lookupIds.push(where.id); event('user'); return where.id!=='alice'||c.missing||c.ownerHost?null:{id:'alice',followersCount:123,followingCount:456,isSuspended:c.suspended??false}; }},
  userProfilesRepository:{async findOneByOrFail({userId}) {assert.equal(userId,'alice');event('profile'); if(c.missingProfile) throw Error('profile missing'); return {[`${c.direction}Visibility`]:c.visibility??'public',[`${c.direction==='followers'?'following':'followers'}Visibility`]:c.otherVisibility??'public'};}},
  followingsRepository:{async find(q) {event('relations');relationCursors.push(q.where.id?._value ?? null);assert.equal(q.take,11);assert.equal(q.order.id,-1);assert.equal(q.where[c.direction==='followers'?'followeeId':'followerId'],'alice');assert.equal(Object.keys(q.where).length,q.where.id?2:1);if(q.where.id) assert.equal(q.where.id._type,'lessThan');return rows.filter(r=>!q.where.id||r.id<q.where.id._value).sort((a,b)=>a.id<b.id?1:-1).slice(0,11);}}
 };
 const app = Fastify();
 try {
  await app.register(server.createServer.bind(receiver));
  const response = await app.inject({method:c.method??'GET',url:`/users/${c.pathUser??'alice'}/${c.direction}${c.query??''}`,headers:c.accept===null?{}:{accept:c.accept??'application/activity+json'}});
  if(response.statusCode===500) assert(c.missingProfile||c.missingMember||c.fail,`${c.id} unexpected 500: ${response.body}`);
  const headers = Object.fromEntries(['cache-control','content-type','vary','access-control-allow-headers','access-control-allow-methods','access-control-allow-origin','access-control-expose-headers'].map(k=>[k,response.headers[k]??null]));
  cases.push({id:c.id,expected:{status:response.statusCode,headers,bodyEmpty:response.body==='',...(response.statusCode===200&&c.method!=='HEAD'?{json:JSON.parse(response.body)}:{}),events,relationCursors,lookupIds,metaEntries,...(c.pathUser&&response.statusCode===400&&headers['access-control-allow-origin']===null&&c.method!=='HEAD'?{errorProjection:(({statusCode,error})=>({statusCode,error}))(JSON.parse(response.body))}:{})}});
 } finally {await app.close();}
}
const output=JSON.stringify({upstreamCommit:pin,runtime:{node:process.version,fastify:require('fastify/package.json').version,fastifyAccepts:require('@fastify/accepts/package.json').version,typescript:ts.version,typeorm:JSON.parse(readFileSync(require.resolve('typeorm').replace(/index\.js$/, 'package.json'), 'utf8')).version},queryParser,manifest,corpusSha256:sha(corpusBytes),doubles:corpus.doubles,cases},null,2)+'\n';
const target=new URL('./local-follow-collections-observations.json',import.meta.url);
if(process.argv[2]==='--write') writeFileSync(target,output); else assert.equal(readFileSync(target,'utf8'),output);
console.log(`local follow source: ${cases.length} cases ${process.argv[2]}`);
