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
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { Ajv } = require('ajv');
const { IsNull } = require('typeorm');
const root = process.env.UPSTREAM_ROOT;
assert(root, 'UPSTREAM_ROOT is required');
assert(['--write', '--check'].includes(process.argv[2]));
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
const manifest = [];
const globals = { IsNull, Object, Date, awaitAll: async input => Object.fromEntries(await Promise.all(Object.entries(input).map(async ([k,v]) => [k,await v]))), ApiError: class extends Error { constructor(meta) { super(meta.message); this.code = meta.code; this.id = meta.id; } } };
function source(path) {
 const bytes = readFileSync(`${root}/${path}`);
 assert.deepEqual(bytes, git('show', `${pin}:${path}`));
 manifest.push({ path, gitBlob:git('rev-parse', `${pin}:${path}`).toString().trim(), sha256:sha(bytes) });
 return ts.createSourceFile(path,bytes.toString(),ts.ScriptTarget.Latest,true);
}
function compile(node,sf) {
 return vm.runInNewContext(ts.transpile(`(${node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)})`,{target:ts.ScriptTarget.ES2022}),globals);
}
const aidx = source('packages/backend/src/misc/id/aidx.ts');
for (const name of ['TIME2000','TIME_LENGTH']) {
 const declaration = aidx.statements.flatMap(n=>ts.isVariableStatement(n)?[...n.declarationList.declarations]:[]).find(n=>n.name.getText(aidx)===name);
 globals[name] = vm.runInNewContext(declaration.initializer.getText(aidx));
}
globals.parseAidx = compile(aidx.statements.find(n=>n.name?.getText(aidx)==='parseAidx'),aidx);
const idSource=source('packages/backend/src/core/IdService.ts');
const parseId=compile(idSource.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='IdService').members.find(n=>n.name?.getText(idSource)==='parse'),idSource);
const packSource=source('packages/backend/src/core/entities/DriveFolderEntityService.ts');
const pack=compile(packSource.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='DriveFolderEntityService').members.find(n=>n.name?.getText(packSource)==='pack'),packSource);
const endpoints={};
const ajv = new Ajv({useDefaults:true}); ajv.addFormat('misskey:id',/^[a-zA-Z0-9]+$/);
for (const op of ['create','delete','find','show','update']) {
 const sf=source(`packages/backend/src/server/api/endpoints/drive/folders/${op}.ts`);
 const variables=sf.statements.flatMap(n=>ts.isVariableStatement(n)?[...n.declarationList.declarations]:[]);
 const schema=vm.runInNewContext(ts.transpile(`(${variables.find(n=>n.name.getText(sf)==='paramDef').initializer.getText(sf)})`,{target:ts.ScriptTarget.ES2022}));
 const meta=vm.runInNewContext(ts.transpile(`(${variables.find(n=>n.name.getText(sf)==='meta').initializer.getText(sf)})`,{target:ts.ScriptTarget.ES2022}),{ms:()=>3600000});
 const klass=sf.statements.find(ts.isClassDeclaration);
 const ctor=klass.members.find(ts.isConstructorDeclaration);
 const call=ctor.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.kind===ts.SyntaxKind.SuperKeyword).expression;
 endpoints[op]={handle:compile(call.arguments[2],sf),validate:ajv.compile(schema),meta};
}
const gateSource=source('packages/backend/src/server/api/ApiCallService.ts');
source('packages/backend/src/server/api/RateLimiterService.ts');
source('packages/backend/src/core/GlobalEventService.ts');
const gateCall=gateSource.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='ApiCallService').members.find(n=>n.name?.getText(gateSource)==='call');
const gateStatements=gateCall.body.statements.filter(n=>ts.isIfStatement(n)&&['ep.meta.limit','ep.meta.requireCredential || ep.meta.requireModerator || ep.meta.requireAdmin',"token && ((ep.meta.kind && !token.permission.some(p => p === ep.meta.kind))\n\t\t\t|| (!ep.meta.kind && (ep.meta.requireCredential || ep.meta.requireModerator || ep.meta.requireAdmin)))"].includes(n.expression.getText(gateSource)));
assert.equal(gateStatements.length,3,'literal limit/suspension/scope branches');
const gate=vm.runInNewContext(ts.transpile(`(async function(ep,user,token){const request={ip:'127.0.0.1'};${gateStatements.map(n=>n.getText(gateSource)).join('\n')}})`,{target:ts.ScriptTarget.ES2022}),globals);
const gateCases=[];
for(const c of [{id:'scope-before-input',scope:false},{id:'suspended-before-scope',suspended:true,scope:false},{id:'quota-before-suspended-and-scope',suspended:true,scope:false,exceeded:true},{id:'redis-before-suspended-and-scope',suspended:true,scope:false,fail:true},{id:'factor-zero',factor:0,scope:true}]) {
 const calls=[];let error;
 try { await gate.call({config:{enableIpRateLimit:false},roleService:{async getUserPolicies(){calls.push('policy');return{rateLimitFactor:c.factor??1};}},rateLimiterService:{async limit(){calls.push('limit');if(c.fail)throw Error('Redis unavailable');return c.exceeded?{info:{remaining:0}}:null;}}},{name:'drive/folders/create',meta:{requireCredential:true,kind:'write:drive',limit:{duration:3600000,max:10}}},{id:'alice',isSuspended:c.suspended??false},{permission:c.scope?['write:drive']:[]}); }
 catch(e){assert.notEqual(e.name,'ReferenceError');error=e.code??e.message;}
 gateCases.push({id:c.id,calls,...(error?{error}:{} )});
}
const corpusBytes=readFileSync(new URL('./corpus.json',import.meta.url));
const corpus=JSON.parse(corpusBytes);
const cases=[];
for (const c of corpus.cases) {
 let rows=structuredClone([...corpus.rows,...c.extra??[]]); const events=[];
 const matches=(row,where)=>Object.entries(where).every(([k,v])=>row[k]===(v?._type==='isNull'?null:v));
 const folders={
  async findOneBy(where){if(c.fail==='ancestor' && where.userId===undefined && where.id===corpus.rows[0].id)return null;return structuredClone(rows.find(r=>matches(r,where))??null);},
  async findOneByOrFail(where){const row=await this.findOneBy(where);if(!row)throw Error('folder missing');return row;},
  async findBy(where){return structuredClone(rows.filter(r=>matches(r,where)));},
  async countBy(where){return rows.filter(r=>matches(r,where)).length;},
  async insertOne(row){if(c.fail==='insert')throw Error('insert unavailable');rows.push(structuredClone(row));return row;},
  async update(id,change){if(c.fail==='update')throw Error('update unavailable');rows=rows.map(r=>r.id===id?{...r,...change}:r);},
  async delete(id){if(c.fail==='delete')throw Error('delete unavailable');rows=rows.filter(r=>r.id!==id);},
 };
 const receiver={driveFoldersRepository:folders,driveFilesRepository:{async countBy(where){return(c.files??[]).filter(r=>matches(r,where)).length;}},idService:{gen:()=>corpus.newId,parse:id=>parseId.call({method:'aidx'},id)},globalEventService:{publishDriveStream(userId,type,body){events.push({userId,type,body});}}};
 receiver.pack=pack;receiver.driveFolderEntityService={pack:(...args)=>pack.call(receiver,...args)};
 const input=structuredClone(c.input); let result,error;
 try {const ep=endpoints[c.operation];globals.meta=ep.meta;if(!ep.validate(input)){error={code:'INVALID_PARAM'};}else{result=await ep.handle.call(receiver,input,{id:corpus.actorId});}}
 catch(e){assert.notEqual(e.name,'ReferenceError');error=e.code?{code:e.code,id:e.id}:{message:e.message};}
 cases.push({id:c.id,expected:JSON.parse(JSON.stringify({...(result===undefined?{}:{result}),...(error?{error}:{}),rows,events}))});
}
const output=JSON.stringify({upstreamCommit:pin,manifest,corpusSha256:sha(corpusBytes),doubles:corpus.doubles,gateCases,cases},null,2)+'\n';
const target=new URL('./observations.json',import.meta.url);
if(process.argv[2]==='--write')writeFileSync(target,output);else assert.equal(readFileSync(target,'utf8'),output);
console.log(`drive-folders source: ${cases.length} cases ${process.argv[2]}`);
