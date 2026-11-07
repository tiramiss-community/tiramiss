/* SPDX-FileCopyrightText: 2026 tiramiss-community */
/* SPDX-License-Identifier: AGPL-3.0-only */
// Independent oracle: every method body comes from the fixed Git blob.
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = process.env.UPSTREAM_ROOT || process.argv[2];
if (!root) throw new Error('Pass fixed upstream checkout path as argument or UPSTREAM_ROOT');
const requireRoot = createRequire(path.join(process.env.REPOSITORY_ROOT || path.resolve(__dirname, '../../../../..'), 'package.json'));
const ts = requireRoot('typescript');
const sha = '8e07cf085adf7009583d234a208e30436f020e26';
const sources = new Map();
const clone = x => JSON.parse(JSON.stringify(x));
function source(file) {
  if (!sources.has(file)) sources.set(file, {
    blob: execFileSync('git', ['-C', root, 'rev-parse', `${sha}:${file}`], {encoding:'utf8'}).trim(),
    text: execFileSync('git', ['-C', root, 'show', `${sha}:${file}`], {encoding:'utf8'}),
  });
  return sources.get(file).text;
}
function compile(text, filename, extras={}) {
  const module = {exports:{}};
  const noop = () => () => {};
  class Empty {}
  const output = ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true,emitDecoratorMetadata:false}}).outputText;
  vm.runInNewContext(output, {module,exports:module.exports,require:specifier => {
    if(specifier==='@nestjs/common') return {Inject:noop,Injectable:noop};
    if(specifier==='@/decorators.js') return {bindThis:()=>{}};
    if(specifier==='@/di-symbols.js') return {DI:{}};
    return new Proxy({}, {get:()=>Empty});
  },console,Date,Set,Map,Promise,Object,Reflect,...extras},{filename});
  return module.exports;
}
function extractMethods(file,className,names) {
  const s = ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true);
  const cls = s.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===className);
  assert(cls, className);
  const members = cls.members.filter(n=>names.includes(n.name?.getText(s)));
  assert.equal(members.length,names.length);
  return members.map(n=>n.getText(s)).join('\n');
}
const searchFile='packages/backend/src/core/SearchService.ts';
const SearchService=compile(source(searchFile),searchFile).SearchService;
const createFile='packages/backend/src/core/NoteCreateService.ts';
const CreateIndex=compile(`export class CreateIndex {${extractMethods(createFile,'NoteCreateService',['index'])}}`,createFile,{bindThis:()=>{}}).CreateIndex;
const createAst=ts.createSourceFile(createFile,source(createFile),ts.ScriptTarget.Latest,true);
const notificationManagerText=createAst.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='NotificationManager').getText(createAst);
const PostCreated=compile(`${notificationManagerText}\nexport class PostCreated {${extractMethods(createFile,'NoteCreateService',['postNoteCreated','index'])}}`,createFile,{bindThis:()=>{},trackPromise:()=>{}}).PostCreated;
const deleteFile='packages/backend/src/core/NoteDeleteService.ts';
const Delete=compile(`export class Delete {${extractMethods(deleteFile,'NoteDeleteService',['delete'])}}`,deleteFile,{isRenote:()=>false,isQuote:()=>false}).Delete;
const globalFile='packages/backend/src/GlobalModule.ts';
const globalAst=ts.createSourceFile(globalFile,source(globalFile),ts.ScriptTarget.Latest,true);
const declaration=globalAst.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(n=>n.name.getText(globalAst)==='$meilisearch');
const factory=declaration.initializer.properties.find(n=>n.name?.getText(globalAst)==='useFactory').initializer.getText(globalAst);
const Factory=compile(`export const factory = ${factory};`,globalFile,{Meilisearch:class {constructor(options){this.options=options;}}}).factory;
const observations=[];
const base={id:'noteid',userId:'author',userHost:null,channelId:null,text:'needle',cw:null,tags:['tag'],visibility:'public',createdAt:new Date(0),localOnly:true};
function context(config={fulltextSearch:{provider:'meilisearch'},meilisearch:{index:'fixture'}}, options={}) {
  const calls=[];
  const pending=()=>new Promise(()=>{});
  const index={updateSettings:settings=>{calls.push({method:'updateSettings',settings:clone(settings)});return options.holdSettings?pending():Promise.resolve({taskUid:1,status:'enqueued'});},
    addDocuments:(documents,optionsArg)=>{calls.push({method:'addDocuments',documents:clone(documents),options:clone(optionsArg)});return options.failAdd?Promise.reject(new Error('add failed')):options.holdAdd?pending():Promise.resolve({taskUid:2,status:'enqueued'});},
    deleteDocument:id=>{calls.push({method:'deleteDocument',id});return options.failDelete?Promise.reject(new Error('delete failed')):options.holdDelete?pending():Promise.resolve({taskUid:3,status:'enqueued'});}};
  const client={index:uid=>{calls.push({method:'index',uid});return index;}};
  const service=new SearchService(config,options.noClient?null:client,{}, {}, {}, {parse:id=>{calls.push({method:'parseId',id});return {date:new Date(1730000000123)};}}, {getLogger:()=>({info:()=>{}})},{});
  return {service,calls,index};
}
(async()=>{
  for(const [name,config] of [
    ['absent',{}],['sqlLike',{fulltextSearch:{provider:'sqlLike'},meilisearch:{host:'ignored'}}],
    ['sqlPgroonga',{fulltextSearch:{provider:'sqlPgroonga'},meilisearch:{host:'ignored'}}],
    ['meili-config-without-provider',{meilisearch:{host:'ignored'}}],
    ['enabled-missing',{fulltextSearch:{provider:'meilisearch'}}],
    ['enabled-http',{fulltextSearch:{provider:'meilisearch'},meilisearch:{host:'127.0.0.1',port:7700,apiKey:'fixture-key',index:'fixture'}}],
    ['enabled-https',{fulltextSearch:{provider:'meilisearch'},meilisearch:{host:'search.example',port:'443',ssl:true,apiKey:'fixture-key',index:'fixture'}}]
  ]) {
    try { const result=Factory(config); observations.push({id:`config-${name}`,config,result:result===null?null:clone(result.options)}); }
    catch(error){observations.push({id:`config-${name}`,config,error:error.message});}
  }
  for(const scope of [undefined,'local','global',[],['allowed.example']]) {
    for(const host of [null,'allowed.example','other.example']) {
      for(const visibility of ['public','home','followers','specified']) {
        for(const content of [{text:'needle',cw:null},{text:null,cw:'cw-only'},{text:null,cw:null},{text:'',cw:null}]) {
          const config={fulltextSearch:{provider:'meilisearch'},meilisearch:{index:'fixture',...(scope===undefined?{}:{scope})}};
          const {service,calls}=context(config);const note={...base,...content,userHost:host,visibility};
          await service.indexNote(note);await service.unindexNote(note);
          observations.push({id:`eligibility-${observations.length}`,scope:scope??'(default)',input:clone(note),calls});
        }
      }
    }
  }
  {const {service,calls}=context({}, {noClient:true});await service.indexNote(base);await service.unindexNote(base);observations.push({id:'no-engine-no-ops',calls});assert.equal(calls.length,0);}
  {const {service,calls}=context(undefined,{holdSettings:true});await service.indexNote(base);await service.indexNote({...base,id:'secondid'});observations.push({id:'settings-not-awaited-single-document-no-batch',calls});assert.equal(calls.filter(c=>c.method==='addDocuments').length,2);}
  for(const method of ['indexNote','unindexNote']) {
    const {service,calls}=context(undefined,{[method==='indexNote'?'failAdd':'failDelete']:true});let error;
    try{await service[method](base);}catch(e){error=e.message;}
    observations.push({id:`direct-${method}-rejects`,error,calls});assert(error);
  }
  {
    const calls=[];let resolve;const held=new Promise(r=>resolve=r);const creator=new CreateIndex();
    creator.searchService={indexNote:note=>{calls.push({method:'indexNote',id:note.id});return held;}};
    const result=creator.index(base);assert.equal(result,undefined);calls.push({method:'create-index-returned',result:'undefined'});resolve();await held;
    creator.index({...base,text:null,cw:null});observations.push({id:'create-wrapper-discards-promise-and-skips-empty',calls});assert.equal(calls.filter(c=>c.method==='indexNote').length,1);
  }
  for(const quiet of [false,true]) for(const dbFails of [false,true]) {
    const calls=[];let resolve;const held=new Promise(r=>resolve=r);const instance=new Delete();
    const note={...base,replyId:'parent'};const user={id:'author',host:null};
    Object.assign(instance, {notesRepository:{decrement:async()=>calls.push({method:'decrementReply'}),delete:async()=>{calls.push({method:'dbDelete'});if(dbFails)throw new Error('DB DELETE failed');}},
      searchService:{unindexNote:n=>{calls.push({method:'unindexNote',id:n.id});return held;}},
      globalEventService:{publishNoteStream:()=>calls.push({method:'publishDeleted'})},
      notesChart:{update:()=>{}},perUserNotesChart:{update:()=>{}},meta:{enableStatsForFederatedInstances:false},userEntityService:{isLocalUser:()=>true}});
    let error;try{await instance.delete(user,note,quiet);}catch(e){error=e.message;}
    calls.push({method:'delete-returned',...(error?{error}:{})});resolve();await held;calls.push({method:'unindex-finished-after-delete-return'});
    observations.push({id:`delete-boundary-quiet-${quiet}-db-fails-${dbFails}`,calls});assert(calls.findIndex(c=>c.method==='unindexNote')<calls.findIndex(c=>c.method==='dbDelete'));
  }
  const boundaryObservations=[];
  for(const mode of ['success','pack-reject','mention-preparation-reject','detached-publisher-reject','detached-webhook-reject','detached-ap-render-throw','detached-ap-render-reject','detached-ap-execute-reject']) {
    const calls=[];
    const unhandled=[];
    const onUnhandled=reason=>{unhandled.push(reason?.message??String(reason));};
    process.on('unhandledRejection',onUnhandled);
    const record=name=>calls.push({method:name});
    const instance=new PostCreated();
    Object.assign(instance, {
      notesChart:{update:()=>record('notesChart')},perUserNotesChart:{update:()=>record('perUserNotesChart')},
      meta:{enableChartsForRemoteUser:false,enableStatsForFederatedInstances:false},
      hashtagService:{updateHashtags:()=>record('hashtag-update-start')},
      incNotesCountOfUser:()=>record('count-start'),pushToTl:()=>record('timeline-start'),
      antennaService:{addNoteToAntennas:()=>record('antenna-start')},
      followingsRepository:{findBy:async()=>[]},
      isRenote:()=>false,isQuote:()=>false,
      userEntityService:{isLocalUser:()=>true,isRemoteUser:()=>false},activeUsersChart:{write:()=>record('active-user')},
      noteEntityService:{pack:async()=>{record('pack');if(mode==='pack-reject')throw new Error('pack failed');return {id:'noteid',packed:true};}},
      globalEventService:{publishNotesStream:()=>{record('publish-notes-start');if(mode==='detached-publisher-reject')return Promise.reject(new Error('publisher failed'));}},
      roleService:{addNoteToRoleTimeline:()=>record('role-timeline-start')},
      webhookService:{enqueueUserWebhook:()=>{record('webhook-start');if(mode==='detached-webhook-reject')return Promise.reject(new Error('webhook failed'));}},
      createMentionedEvents:async()=>{record('mention-preparation');if(mode==='mention-preparation-reject')throw new Error('mention preparation failed');},
      renderNoteOrRenoteActivity:()=>{record('ap-render-start');if(mode==='detached-ap-render-throw')throw new Error('AP render threw');return mode==='detached-ap-render-reject'?Promise.reject(new Error('AP render rejected')):Promise.resolve({type:'Create'});},
      apDeliverManagerService:{createDeliverManager:()=>{record('ap-manager-start');return {addFollowersRecipe:()=>record('ap-followers-recipe'),execute:()=>{record('ap-execute-start');return mode==='detached-ap-execute-reject'?Promise.reject(new Error('AP execute rejected')):Promise.resolve();}};}},
      relayService:{deliverToRelays:()=>record('ap-relay-start')},
      searchService:{indexNote:note=>{calls.push({method:'search-index-start',id:note.id});return Promise.resolve();}},
    });
    let error;
    try { await instance.postNoteCreated({...base,localOnly:false},{id:'author',username:'author',host:null,isBot:false},{visibility:'public',localOnly:false},false,[],[]); }
    catch(e){error=e.message;}
    calls.push({method:'postNoteCreated-returned',...(error?{error}:{})});
    // Let detached original IIFE/publisher Promise rejections reach the harness process handler.
    await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
    process.off('unhandledRejection',onUnhandled);
    const indexed=calls.some(c=>c.method==='search-index-start');
    assert.equal(indexed,!['pack-reject','mention-preparation-reject'].includes(mode),mode);
    assert.equal(Boolean(error),['pack-reject','mention-preparation-reject'].includes(mode),mode);
    assert.equal(unhandled.length,mode.startsWith('detached-')?1:0,mode);
    boundaryObservations.push({id:mode,calls,indexStarted:indexed,postNoteCreatedRejected:Boolean(error),unhandledRejectionsCapturedByHarness:unhandled});
  }
  const fixture={fixedCommit:sha,evidence:'Fixed Git source runtime with SDK/repository/IdService doubles. No actual Meilisearch or PostgreSQL.',sources:Object.fromEntries([...sources].map(([k,v])=>[k,{blob:v.blob}])),observations};
  const output=process.env.OUTPUT||path.join(process.cwd(),'search-observations.actual.json');fs.writeFileSync(output,JSON.stringify(fixture,null,2)+'\n');
  const boundaryOutput=path.join(path.dirname(output),'post-created-boundaries.json');fs.writeFileSync(boundaryOutput,JSON.stringify({fixedCommit:sha,evidence:'Actual complete fixed postNoteCreated and index method bodies plus actual NotificationManager class; collaborators are doubles. No full server, DB or Meilisearch. Harness captures detached unhandledRejection events.',source:fixture.sources[createFile],observations:boundaryObservations},null,2)+'\n');
  console.log(JSON.stringify({output,cases:observations.length,boundaryOutput,boundaryCases:boundaryObservations.length,sources:fixture.sources}));
})().catch(error=>{console.error(error);process.exitCode=1;});
