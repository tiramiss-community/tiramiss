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
const ts = require('typescript'); const { Ajv } = require('ajv'); const { IsNull, In } = require('typeorm');
const root = process.env.UPSTREAM_ROOT; assert(root); assert(['--write', '--check'].includes(process.argv[2]));
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sha = bytes => createHash('sha256').update(bytes).digest('hex'); const manifest = [];
const globals = { IsNull, In, Object, Date, deepClone: structuredClone,
 awaitAll: async input => Object.fromEntries(await Promise.all(Object.entries(input).map(async ([k,v]) => [k,await v]))),
 ApiError: class extends Error { constructor(meta) { super(meta.message); this.code = meta.code; this.id = meta.id; } },
};
function source(path) {
 const bytes = readFileSync(`${root}/${path}`);
 assert.deepEqual(bytes, execFileSync('git', ['-C',root,'show',`${pin}:${path}`]));
 manifest.push({ path, sha256: sha(bytes), gitBlob: execFileSync('git',['-C',root,'rev-parse',`${pin}:${path}`]).toString().trim() });
 return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function evaluate(text) { return vm.runInNewContext(ts.transpile(`(${text})`,{target:ts.ScriptTarget.ES2022}),globals); }
function compile(node,sf) { return evaluate(`${node.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)?'async ':''}function(${node.parameters.map(p=>p.getText(sf)).join(',')})${node.body.getText(sf)}`); }
function variable(sf,name) { return sf.statements.flatMap(n=>ts.isVariableStatement(n)?[...n.declarationList.declarations]:[]).find(n=>n.name.getText(sf)===name); }
function methods(sf,name) { return Object.fromEntries(sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===name).members.filter(ts.isMethodDeclaration).map(n=>[n.name.getText(sf),compile(n,sf)])); }
const aidx=source('packages/backend/src/misc/id/aidx.ts');
for(const name of ['TIME2000','TIME_LENGTH']) globals[name]=evaluate(variable(aidx,name).initializer.getText(aidx));
globals.parseAidx=compile(aidx.statements.find(n=>n.name?.getText(aidx)==='parseAidx'),aidx);
const ids=methods(source('packages/backend/src/core/IdService.ts'),'IdService');
const fileMethods=methods(source('packages/backend/src/core/entities/DriveFileEntityService.ts'),'DriveFileEntityService');
const folderMethods=methods(source('packages/backend/src/core/entities/DriveFolderEntityService.ts'),'DriveFolderEntityService');
const video=methods(source('packages/backend/src/core/VideoProcessingService.ts'),'VideoProcessingService');
const urlSource=source('packages/backend/src/misc/prelude/url.ts');
for(const name of ['query','appendQuery']) globals[name]=compile(urlSource.statements.find(n=>n.name?.getText(urlSource)===name),urlSource);
const mime=source('packages/backend/src/misc/is-mime-image.ts');
globals.FILE_TYPE_BROWSERSAFE=[]; globals.dictionary=evaluate(variable(mime,'dictionary').initializer.getText(mime));
globals.isMimeImage=evaluate(variable(mime,'isMimeImage').initializer.getText(mime));
const uniqueSource=source('packages/backend/src/misc/unique-by-key.ts');
globals.uniqueByKey=compile(uniqueSource.statements.find(n=>n.name?.getText(uniqueSource)==='uniqueByKey'),uniqueSource);
const endpoints={}; const ajv=new Ajv({useDefaults:true}); ajv.addFormat('misskey:id',/^[a-zA-Z0-9]+$/);
for(const [op,path] of [['show','drive/files/show'],['find','drive/files/find'],['findByHash','drive/files/find-by-hash'],['checkExistence','drive/files/check-existence'],['adminShow','admin/drive/show-file']]) {
 const sf=source(`packages/backend/src/server/api/endpoints/${path}.ts`); const klass=sf.statements.find(ts.isClassDeclaration);
 const ctor=klass.members.find(ts.isConstructorDeclaration); const superCall=ctor.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.kind===ts.SyntaxKind.SuperKeyword).expression;
 endpoints[op]={meta:evaluate(variable(sf,'meta').initializer.getText(sf)),validate:ajv.compile(evaluate(variable(sf,'paramDef').initializer.getText(sf))),handle:compile(superCall.arguments[2],sf)};
}
const bytes=readFileSync(new URL('./corpus.json',import.meta.url)); const corpus=JSON.parse(bytes);
const normalize=x=>JSON.parse(JSON.stringify(x));
const matches=(row,where)=>Array.isArray(where)?where.some(w=>matches(row,w)):Object.entries(where).every(([k,v])=>row[k]===(v?._type==='isNull'?null:v));
function receiver(rows=corpus.rows, config={}) {
 const repo={async findOneBy(where){return rows.find(r=>matches(r,where))??null;},async findOneByOrFail(where){const row=await this.findOneBy(where);if(!row)throw Error('file missing');return row;},async findBy(where){return rows.filter(r=>matches(r,where));},async exists({where}){return rows.some(r=>matches(r,where));}};
 const r={...fileMethods,config:{url:'https://local',mediaProxy:'https://local/proxy',videoThumbnailGenerator:'https://video',...config},meta:{proxyRemoteFiles:false},driveFilesRepository:repo,
 idService:{parse:id=>ids.parse.call({method:'aidx'},id)},roleService:{async isModerator(user){return user.id==='mod';}},usersRepository:{async findOneByOrFail({id}){return{id};}},userEntityService:{async pack(id){return{id,username:id};}},
 };
 const folder={...folderMethods,idService:r.idService,driveFoldersRepository:{async findOneByOrFail({id}){const f=corpus.folders.find(f=>f.id===id);if(!f)throw Error('folder missing');return f;},async countBy(where){return corpus.folders.filter(f=>matches(f,where)).length;}},driveFilesRepository:{async countBy(where){return rows.filter(f=>matches(f,where)).length;}}};
 folder.pack=folder.pack.bind(folder); r.driveFolderEntityService=folder;
 r.videoProcessingService={getExternalVideoThumbnailUrl:url=>video.getExternalVideoThumbnailUrl.call(r,url)};
 r.pack=r.pack.bind(r); r.packNullable=r.packNullable.bind(r);
 r.packMany=r.packMany.bind(r);
 r.driveFileEntityService=r;return r;
}
const cases=[];
for(const c of corpus.cases) {
 const r=receiver(); if(c.fail)r.driveFilesRepository.findOneBy=async()=>{throw Error('database unavailable');};
 const ep=endpoints[c.operation]; globals.meta=ep.meta; const input=structuredClone(c.input);let result,error;
 try { if(!ep.validate(input))error={code:'INVALID_PARAM'};else result=await ep.handle.call(r,input,{id:c.actor}); }
 catch(e){assert.notEqual(e.name,'ReferenceError');error=e.code?{code:e.code,id:e.id}:{message:e.message};}
 cases.push({id:c.id,expected:normalize({...(result===undefined?{}:{result}),...(error?{error}:{})})});
}
const packing=[];
for(const c of corpus.packing) {
 const r=receiver(undefined,{externalMediaProxyEnabled:c.external??false,...('video' in c?{videoThumbnailGenerator:c.video}:{})}); r.meta.proxyRemoteFiles=c.proxy??false;
 const file={...structuredClone(corpus.rows[0]),...c.patch};
 packing.push({id:c.id,expected:normalize(await r[c.options.nullable?'packNullable':'pack'](file,c.options))});
}
const names=corpus.names.map(name=>({name,expected:fileMethods.validateFileName(name)}));
const output=JSON.stringify({upstreamCommit:pin,manifest,corpusSha256:sha(bytes),doubles:corpus.doubles,cases,packing,names},null,2)+'\n';
const target=new URL('./observations.json',import.meta.url); if(process.argv[2]==='--write')writeFileSync(target,output);else assert.equal(readFileSync(target,'utf8'),output);
console.log(`drive-files source: ${cases.length} endpoint + ${packing.length} pack + ${names.length} name cases ${process.argv[2]}`);
