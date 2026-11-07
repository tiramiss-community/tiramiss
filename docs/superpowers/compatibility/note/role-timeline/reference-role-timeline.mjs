/* SPDX-FileCopyrightText: 2026 tiramiss-community */
/* SPDX-License-Identifier: AGPL-3.0-only */
// Methods and caches are extracted verbatim from a pinned Git blob, then transpiled.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repository = process.env.REPOSITORY_ROOT || fileURLToPath(new URL('../../../../../', import.meta.url));
const ts = createRequire(path.join(repository, 'package.json'))('typescript');
const root = process.env.UPSTREAM_ROOT;
assert(root, 'Set UPSTREAM_ROOT to a Git checkout containing the pinned upstream commit');
const output = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(tmpdir(), 'role-timeline-reference-'));
fs.mkdirSync(output, { recursive: true });
const sha = '8e07cf085adf7009583d234a208e30436f020e26';
const sources = new Map();
const NOW = 1700000000000;
let now = NOW, random = 0.5;
class Clock extends Date { static now() { return now; } }
const clone = x => JSON.parse(JSON.stringify(x));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function source(file) {
  if (!sources.has(file)) {
    const text = execFileSync('git', ['-C', root, 'show', `${sha}:${file}`], {encoding:'utf8'});
    sources.set(file, {text, blob:execFileSync('git', ['-C', root, 'rev-parse', `${sha}:${file}`], {encoding:'utf8'}).trim()});
    fs.mkdirSync(path.join(output,'sources',path.dirname(file)),{recursive:true});
    fs.writeFileSync(path.join(output,'sources',file),text);
  }
  return sources.get(file).text;
}
function declaration(file, name) {
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name);
  assert(node, name); return {ast,node};
}
function methods(file, name, names) {
  const {ast,node} = declaration(file,name);
  const selected = node.members.filter(n => names.includes(n.name?.getText(ast)));
  assert.equal(selected.length,names.length);
  return selected.map(n => n.getText(ast)).join('\n');
}
function compile(text,file,extras={}) {
  const module={exports:{}};
  const output = ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true,emitDecoratorMetadata:false}}).outputText;
  const math = Object.create(Math); math.random=()=>random;
  vm.runInNewContext(output, {module,exports:module.exports,Date:Clock,Math:math,Promise,Set,Map,Object,Reflect,
    setInterval:()=>0,clearInterval:()=>{},bindThis:()=>{},trackPromise:()=>{},
    require:specifier=>{if(specifier==='@/decorators.js')return {bindThis:()=>{}};throw new Error(`Unexpected import ${specifier}`);},...extras},{filename:file});
  return module.exports;
}
const roleFile='packages/backend/src/core/RoleService.ts';
const cacheFile='packages/backend/src/misc/cache.ts';
const userCacheFile='packages/backend/src/core/CacheService.ts';
const fanoutFile='packages/backend/src/core/FanoutTimelineService.ts';
const createFile='packages/backend/src/core/NoteCreateService.ts';
const globalFile='packages/backend/src/core/GlobalEventService.ts';
const classes=['MemoryKVCache','MemorySingleCache'].map(name=>{const {ast,node}=declaration(cacheFile,name);return node.getText(ast);}).join('\n');
const caches=compile(classes,cacheFile);
const Role=compile(`export class Role {${methods(roleFile,'RoleService',['evalCond','getUserAssigns','getUserRoles','addNoteToRoleTimeline','onMessage'])}}`,roleFile).Role;
const UserCache=compile(`export class UserCache {${methods(userCacheFile,'CacheService',['findUserById'])}}`,userCacheFile).UserCache;
const Fanout=compile(`export class Fanout {${methods(fanoutFile,'FanoutTimelineService',['push'])}}`,fanoutFile).Fanout;
const Global=compile(`export class Global {${methods(globalFile,'GlobalEventService',['publish','publishRoleTimelineStream'])}}`,globalFile).Global;
const nm=declaration(createFile,'NotificationManager');
const Post=compile(`${nm.node.getText(nm.ast)}\nexport class Post {${methods(createFile,'NoteCreateService',['postNoteCreated','incNotesCountOfUser'])}}`,createFile).Post;
const deleteFile='packages/backend/src/core/NoteDeleteService.ts';
const Delete=compile(`export class Delete {${methods(deleteFile,'NoteDeleteService',['delete'])}}`,deleteFile,{isRenote:()=>false,isQuote:()=>false}).Delete;
const baseUser={id:'author',host:null,createdAtMs:0,isSuspended:false,isLocked:false,isBot:false,isCat:false,isExplorable:false,followersCount:0,followingCount:0,notesCount:9};
const baseNote={id:String(NOW),userId:'author',userHost:null,visibility:'public',channelId:null,text:'content',cw:null,fileIds:[],visibleUserIds:[],localOnly:true};
const manual=(id,more={})=>({id,target:'manual',condFormula:{},isPublic:false,isExplorable:false,...more});
const conditional=(id,condFormula,more={})=>manual(id,{target:'conditional',condFormula,...more});
const assignment=(roleId,expiresAt=null)=>({id:`assignment-${roleId}`,roleId,userId:'author',expiresAt});
function setup({roles=[manual('role')],assignments=[assignment('role')],user=baseUser,tail=null,mode='ok'}={}) {
  const calls=[]; const record=(method,body={})=>calls.push({method,...clone(body)});
  const state={roles:clone(roles),assignments:assignments.map(a=>({...a})),user:{...user},tail};
  const execHeld=deferred(), pubHeld=deferred(), lookupHeld=deferred();
  const pipeline={lpush:(key,id)=>record('pipeline.lpush',{key,id}),ltrim:(key,start,end)=>record('pipeline.ltrim',{key,start,end}),exec:()=>{record('pipeline.exec');return mode==='hold-exec'?execHeld.promise:mode==='reject-exec'?Promise.reject(new Error('exec failed')):Promise.resolve([[null,1]]);}};
  const redis={pipeline:()=>{record('pipeline');return pipeline;},lindex:async(key,index)=>{record('lindex',{key,index});if(mode==='reject-lindex')throw new Error('lindex failed');return state.tail;},lpush:async(key,id)=>record('direct.lpush',{key,id})};
  const idService={parse:id=>({date:new Date(Number(id))})};
  const userCache=new UserCache();Object.assign(userCache,{userByIdCache:new caches.MemoryKVCache(300000),usersRepository:{findOneByOrFail:async()=>{record('readUser');return {...state.user};}}});
  const role=new Role();Object.assign(role,{rolesCache:new caches.MemorySingleCache(3600000),roleAssignmentByUserIdCache:new caches.MemoryKVCache(300000),
    rolesRepository:{findBy:async()=>{record('readRoles');if(mode==='reject-roles')throw new Error('roles failed');if(mode==='hold-roles')await lookupHeld.promise;return clone(state.roles);}},
    roleAssignmentsRepository:{findBy:async()=>{record('readAssignments');return state.assignments.map(a=>({...a}));}},
    cacheService:userCache,userEntityService:{isLocalUser:u=>u.host==null,isRemoteUser:u=>u.host!=null},idService,
    redisForTimelines:redis,fanoutTimelineService:Object.assign(new Fanout(),{redisForTimelines:redis,idService}),
    globalEventService:{publishRoleTimelineStream:(id,type,note)=>{record('rolePublication',{roleId:id,type,note});if(mode==='throw-publication')throw new Error('publication threw');return mode==='hold-publication'?pubHeld.promise:mode==='reject-publication'?Promise.reject(new Error('publication failed')):undefined;}}});
  return {role,state,calls,record,execHeld,pubHeld,lookupHeld,userCache};
}
function postContext(f,{packFail=false,mentionFail=false}={}) {
  const post=new Post();const rec=name=>f.record(name);
  Object.assign(post,{notesChart:{update:()=>rec('notesChart')},perUserNotesChart:{update:()=>{}},meta:{enableChartsForRemoteUser:false,enableStatsForFederatedInstances:false},
    hashtagService:{updateHashtags:()=>{}},incNotesCountOfUser:()=>rec('count-start'),pushToTl:()=>rec('other-timelines-start'),antennaService:{addNoteToAntennas:()=>{}},
    saveReply:()=>{},followingsRepository:{findBy:async()=>[]},isRenote:data=>!!data.renote,isQuote:()=>false,incRenoteCount:()=>{},
    queueService:{endedPollNotificationQueue:{add:()=>{}}},userEntityService:{isLocalUser:u=>u.host==null,isRemoteUser:u=>u.host!=null},activeUsersChart:{write:()=>{}},
    noteEntityService:{pack:async n=>{rec('pack');if(packFail)throw new Error('pack failed');return {...n,packed:true};}},
    globalEventService:{publishNotesStream:()=>rec('notesPublication'),publishMainStream:()=>{}},roleService:f.role,
    webhookService:{enqueueUserWebhook:()=>rec('webhook-start')},createMentionedEvents:async()=>{rec('mention-preparation');if(mentionFail)throw new Error('mention failed');},
    noteThreadMutingsRepository:{exists:async()=>false},channelsRepository:{increment:async()=>{},update:async()=>{}},notesRepository:{countBy:async()=>2},
    renderNoteOrRenoteActivity:async()=>({}),apDeliverManagerService:{createDeliverManager:()=>({addFollowersRecipe:()=>{},execute:async()=>{}})},relayService:{deliverToRelays:()=>{}},index:()=>rec('index-start')});
  return post;
}
const observations=[];
async function capture(id,run) {
  const unhandled=[];const listener=e=>unhandled.push(e?.message??String(e));process.on('unhandledRejection',listener);
  try {const value=await run();await tick();await tick();observations.push({id,...value,unhandledRejectionsCapturedByHarness:unhandled});}
  finally{process.off('unhandledRejection',listener);now=NOW;random=0.5;}
}
(async()=>{
  // Actual complete postNoteCreated, with actual RoleService and fanout method bodies.
  for(const visibility of ['public','home','followers','specified'])for(const remote of [false,true])for(const channel of [false,true])for(const localOnly of [false,true])for(const silent of [false,true])for(const packFail of [false,true]) {
    const id=`gate-${visibility}-remote${remote}-channel${channel}-localOnly${localOnly}-silent${silent}-packFail${packFail}`;
    await capture(id,async()=>{const f=setup();const post=postContext(f,{packFail});const note={...baseNote,visibility,userHost:remote?'remote.example':null,channelId:channel?'channel':null,localOnly};const user={...baseUser,host:note.userHost};let error;
      try{await post.postNoteCreated(note,user,{visibility,localOnly,channel:channel?{id:'channel'}:null},silent,[],[]);}catch(e){error=e.message;}await tick();
      assert.equal(f.calls.filter(c=>c.method==='rolePublication').length,!silent&&!packFail?1:0,id);
      return {input:{visibility,remote,channel,localOnly,silent,packFail},calls:f.calls,...(error?{error}:{})};});
  }
  const selections=[
    ['empty',[],[]],['unassigned-manual',[manual('m')],[]],['assigned-manual',[manual('m')],[assignment('m')]],
    ['expires-equal',[manual('m')],[assignment('m',new Date(NOW))]],['expires-past',[manual('m')],[assignment('m',new Date(NOW-1))]],['expires-future',[manual('m')],[assignment('m',new Date(NOW+1))]],
    ['deleted-role',[manual('other')],[assignment('missing')]],['duplicate-assignments',[manual('m')],[assignment('m'),assignment('m')]],
    ['conditional-local',[conditional('c',{type:'isLocal'})],[]],['conditional-remote',[conditional('c',{type:'isRemote'})],[]],
    ['conditional-private-unexplorable',[conditional('c',{type:'isLocal'},{isPublic:false,isExplorable:false})],[]],
    ['conditional-assigned-and-matched-duplicates',[conditional('c',{type:'isLocal'})],[assignment('c')]],
    ['conditional-invalid',[conditional('c',null)],[]],
    ['conditional-based-on-assignment',[manual('m'),conditional('c',{type:'roleAssignedTo',roleId:'m'})],[assignment('m')]],
    ['conditional-does-not-chain',[conditional('c',{type:'isLocal'}),conditional('d',{type:'roleAssignedTo',roleId:'c'})],[]],
    ['manual-before-condition-order',[conditional('c',{type:'isLocal'}),manual('b'),manual('a')],[assignment('a'),assignment('b')]],
  ];
  for(const [id,roles,assignments] of selections)await capture(`membership-${id}`,async()=>{const f=setup({roles,assignments});await f.role.addNoteToRoleTimeline(baseNote);return {input:{roles,assignments},calls:f.calls};});
  for(const field of ['isSuspended','isLocked','isBot','isCat','isExplorable'])for(const value of [false,true])await capture(`current-user-${field}-${value}`,async()=>{const f=setup({roles:[conditional('c',{type:field})],assignments:[],user:{...baseUser,[field]:value}});await f.role.addNoteToRoleTimeline(baseNote);assert.equal(f.calls.filter(c=>c.method==='rolePublication').length,value?1:0);return {input:{field,value},calls:f.calls};});
  for(const type of ['notesLessThanOrEq','notesMoreThanOrEq','followersLessThanOrEq','followersMoreThanOrEq','followingLessThanOrEq','followingMoreThanOrEq'])for(const value of [8,9,10])await capture(`condition-${type}-${value}`,async()=>{const f=setup({roles:[conditional('c',{type,value})],assignments:[],user:{...baseUser,notesCount:9,followersCount:9,followingCount:9}});await f.role.addNoteToRoleTimeline(baseNote);return {input:{type,value},calls:f.calls};});
  for(const type of ['createdLessThan','createdMoreThan'])for(const sec of [0.999,1,1.001])await capture(`condition-${type}-${sec}`,async()=>{const userId=String(NOW-1000);const f=setup({roles:[conditional('c',{type,sec})],assignments:[],user:{...baseUser,id:userId}});await f.role.addNoteToRoleTimeline({...baseNote,userId});return {input:{type,sec,userCreatedAtMs:NOW-1000,atMs:NOW},calls:f.calls};});
  for(const age of [179999,180000,180001])for(const tail of [null,NOW-180002,NOW-180000,NOW])for(const roll of [0.099999,0.1])await capture(`fanout-age${age}-tail${tail}-roll${roll}`,async()=>{random=roll;const f=setup({tail:tail===null?null:String(tail)});await f.role.addNoteToRoleTimeline({...baseNote,id:String(NOW-age)});await tick();return {input:{now:NOW,noteId:String(NOW-age),tail,random:roll},calls:f.calls};});
  for(const mode of ['hold-exec','hold-publication','hold-roles','reject-exec','reject-publication','reject-roles','reject-lindex','throw-publication'])await capture(`lifetime-${mode}`,async()=>{const f=setup({mode});let returned=false,error;
    const pending=f.role.addNoteToRoleTimeline({...baseNote,id:String(mode==='reject-lindex'?NOW-180000:NOW)}).then(()=>{returned=true;f.record('add-returned');},e=>{returned=true;error=e.message;f.record('add-rejected',{error});});
    await tick();const returnedBeforeRelease=returned;if(mode==='hold-roles'){assert(!returned);f.lookupHeld.resolve();}else if(mode==='hold-exec'||mode==='hold-publication'){assert(returned);f.execHeld.resolve([]);f.pubHeld.resolve();}await pending;return {returnedBeforeRelease,...(error?{error}:{}),calls:f.calls};});
  for(const mode of ['hold-roles','reject-roles','reject-exec','reject-publication','throw-publication'])await capture(`post-boundary-${mode}`,async()=>{const f=setup({mode});await postContext(f).postNoteCreated(baseNote,baseUser,{visibility:'public',localOnly:true},false,[],[]);f.record('post-returned');await tick();if(mode==='hold-roles'){assert(f.calls.some(c=>c.method==='index-start'));assert(!f.calls.some(c=>c.method==='rolePublication'));f.lookupHeld.resolve();await tick();}return {calls:f.calls};});
  await capture('post-boundary-mention-preparation-reject',async()=>{const f=setup();let error;try{await postContext(f,{mentionFail:true}).postNoteCreated(baseNote,baseUser,{visibility:'public',localOnly:true},false,[],[]);}catch(e){error=e.message;}await tick();assert(f.calls.some(c=>c.method==='rolePublication'));assert(!f.calls.some(c=>c.method==='index-start'));return {error,calls:f.calls};});
  await capture('cache-role-assignment-expiry-filter-on-every-use',async()=>{const f=setup({assignments:[assignment('role',new Date(NOW+1))]});await f.role.addNoteToRoleTimeline(baseNote);now++;await f.role.addNoteToRoleTimeline(baseNote);assert.equal(f.calls.filter(c=>c.method==='readAssignments').length,1);assert.equal(f.calls.filter(c=>c.method==='rolePublication').length,1);return {calls:f.calls};});
  await capture('cache-user-current-at-lookup-then-stale-for-5m',async()=>{const f=setup({roles:[conditional('c',{type:'notesMoreThanOrEq',value:10})],assignments:[]});await f.role.addNoteToRoleTimeline(baseNote);f.state.user.notesCount=10;await f.role.addNoteToRoleTimeline(baseNote);now+=300000;await f.role.addNoteToRoleTimeline(baseNote);now++;await f.role.addNoteToRoleTimeline(baseNote);assert.equal(f.calls.filter(c=>c.method==='readUser').length,2);assert.equal(f.calls.filter(c=>c.method==='rolePublication').length,1);return {calls:f.calls};});
  await capture('cache-current-user-not-create-snapshot',async()=>{const f=setup({roles:[conditional('c',{type:'notesMoreThanOrEq',value:10})],assignments:[],user:{...baseUser,notesCount:10}});await postContext(f).postNoteCreated(baseNote,{...baseUser,notesCount:9},{visibility:'public',localOnly:true},false,[],[]);await tick();assert.equal(f.calls.filter(c=>c.method==='rolePublication').length,1);return {creationAuthorNotesCount:9,currentLookupNotesCount:10,calls:f.calls};});
  for(const warm of [false,true])for(const countCompletesBeforeRoleRead of [false,true])await capture(`actual-count-race-userCacheWarm${warm}-countCompletesBeforeRoleRead${countCompletesBeforeRoleRead}`,async()=>{
    const f=setup({roles:[conditional('c',{type:'notesMoreThanOrEq',value:10})],assignments:[]});
    if(warm)await f.userCache.findUserById('author');
    const post=postContext(f);const held=deferred();const apply=()=>{f.state.user.notesCount++;f.record('count-completed');};
    const qb={update:()=>qb,set:()=>qb,where:()=>qb,execute:()=>{f.record('count-query-execute');if(countCompletesBeforeRoleRead){apply();return Promise.resolve();}return held.promise.then(apply);}};
    post.usersRepository={createQueryBuilder:()=>qb};post.incNotesCountOfUser=Post.prototype.incNotesCountOfUser.bind(post);
    await post.postNoteCreated(baseNote,baseUser,{visibility:'public',localOnly:true},false,[],[]);await tick();f.record('post-returned-before-held-count-release');
    const publicationsBeforeCountRelease=f.calls.filter(c=>c.method==='rolePublication').length;
    held.resolve();await tick();
    assert.equal(publicationsBeforeCountRelease,!warm&&countCompletesBeforeRoleRead?1:0);
    return {input:{warm,countCompletesBeforeRoleRead},publicationsBeforeCountRelease,calls:f.calls};
  });
  for(const quiet of [false,true])for(const dbFails of [false,true])await capture(`delete-no-role-cleanup-quiet${quiet}-dbFails${dbFails}`,async()=>{
    const f=setup();const del=new Delete();Object.assign(del,{notesRepository:{delete:async()=>{f.record('dbDelete');if(dbFails)throw new Error('db delete failed');}},searchService:{unindexNote:()=>f.record('searchUnindex')},globalEventService:{publishNoteStream:()=>f.record('noteDeletedPublication')},notesChart:{update:()=>{}},perUserNotesChart:{update:()=>{}},meta:{enableStatsForFederatedInstances:false},userEntityService:{isLocalUser:()=>true},roleService:f.role});
    let error;try{await del.delete(baseUser,baseNote,quiet);}catch(e){error=e.message;}
    assert(!f.calls.some(c=>c.method==='pipeline'||c.method==='rolePublication'));
    return {calls:f.calls,...(error?{error}:{})};
  });
  await capture('cache-role-definition-change-event',async()=>{const f=setup();await f.role.addNoteToRoleTimeline(baseNote);await f.role.onMessage('',JSON.stringify({channel:'internal',message:{type:'roleDeleted',body:{id:'role'}}}));await f.role.addNoteToRoleTimeline(baseNote);assert.equal(f.calls.filter(c=>c.method==='rolePublication').length,1);return {calls:f.calls};});
  await capture('global-role-publication-wire',async()=>{const calls=[];const g=Object.assign(new Global(),{config:{host:'instance.example:3000'},redisForPub:{publish:(channel,payload)=>{calls.push({channel,payload:JSON.parse(payload)});return Promise.resolve(1);}}});g.publishRoleTimelineStream('role','note',baseNote);assert.equal(calls[0].payload.channel,'roleTimelineStream:role');assert.equal(calls[0].payload.message.type,'note');return {calls};});
  const result={fixedCommit:sha,evidence:'Actual pinned postNoteCreated/NotificationManager, RoleService methods, Memory caches, CacheService.findUserById, FanoutTimelineService.push, and GlobalEventService.publishRoleTimelineStream. Collaborators, clocks, random, Redis and repositories doubled. No full server/DB/Redis.',sources:Object.fromEntries([...sources].map(([file,{blob}])=>[file,{blob}])),observations};
  fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({cases:observations.length,sources:result.sources,output:path.join(output,'observations.json')}));
})().catch(error=>{console.error(error);process.exitCode=1;});
