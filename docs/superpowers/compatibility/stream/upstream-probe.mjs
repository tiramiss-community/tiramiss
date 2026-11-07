/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const repository = process.env.UPSTREAM_ROOT;
if (!repository) { throw new Error('Set UPSTREAM_ROOT to a checkout containing the pinned Git objects'); }
const sha = '8e07cf085adf7009583d234a208e30436f020e26';
const sourceRoot = 'packages/backend/src/';
const requireRoot = createRequire(path.join(process.env.REPOSITORY_ROOT ?? process.cwd(), 'package.json'));
const ts = requireRoot('typescript');
const observed = [];
const blobs = new Map();
const modules = new Map();
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedNow])); } static now() { return fixedNow; } }
class AuthenticationError extends Error {}
class EmptyService {}
let fakeServer;
class FakeWebSocketServer extends EventEmitter {
  constructor() { super(); fakeServer = this; this.upgrades = []; }
  handleUpgrade(request, socket, head, callback) { this.upgrades.push({request,socket,head}); /* deliberately do not establish stream listeners */ }
  close(callback) { callback(); }
}
function source(relative) {
  const full = sourceRoot + relative;
  if (!blobs.has(full)) {
    const text = execFileSync('git', ['-C', repository, 'show', `${sha}:${full}`], {encoding:'utf8'});
    const blob = execFileSync('git', ['-C', repository, 'rev-parse', `${sha}:${full}`], {encoding:'utf8'}).trim();
    blobs.set(full, {text,blob});
  }
  return blobs.get(full).text;
}
const actualFiles = new Set(['decorators.ts','misc/is-renote.ts','misc/is-instance-muted.ts','misc/is-user-related.ts','misc/is-channel-related.ts','misc/clone.ts','misc/should-hide-note-by-time.ts','server/api/stream/channel.ts','server/api/stream/NoteStreamingHidingService.ts','server/api/stream/Connection.ts','server/api/StreamingApiServerService.ts',...['main','home-timeline','local-timeline','global-timeline','hybrid-timeline'].map(n=>`server/api/stream/channels/${n}.ts`)]);
function load(relative, customSource) {
  if (!customSource && modules.has(relative)) return modules.get(relative).exports;
  const module = {exports:{}};
  if (!customSource) modules.set(relative,module);
  const compiled = ts.transpileModule(customSource ?? source(relative), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true,emitDecoratorMetadata:false}}).outputText;
  const localRequire = specifier => {
    if (specifier === '@nestjs/common') return {Inject:()=>()=>{}, Injectable:()=>()=>{},Scope:{TRANSIENT:'transient'}};
    if (specifier === '@nestjs/core') return {ContextIdFactory:{create:()=>({})},ModuleRef:EmptyService,REQUEST:Symbol('request')};
    if (specifier === '@/di-symbols.js') return {DI:{}};
    if (specifier === 'ws') return {WebSocket:{OPEN:1},WebSocketServer:FakeWebSocketServer};
    if (specifier === 'events') return {EventEmitter};
    if (specifier === 'promise-limit') return ()=>fn=>Promise.resolve().then(fn);
    if (specifier === '@/misc/json-value.js') return {isJsonObject:x=>x!==null&&typeof x==='object'&&!Array.isArray(x)};
    if (specifier.endsWith('/AuthenticateService.js') || specifier === './AuthenticateService.js') return {AuthenticateService:EmptyService,AuthenticationError};
    let resolved = specifier.startsWith('@/') ? specifier.slice(2) : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(relative),specifier)) : null;
    resolved = resolved?.replace(/\.js$/,'.ts');
    if (actualFiles.has(resolved)) return load(resolved);
    return new Proxy({},{get:(_target,key)=>key==='__esModule'?false:EmptyService});
  };
  const context = {module,exports:module.exports,require:localRequire,console,Date:FixedDate,Set,Map,Object,Promise,JSON,Reflect,Symbol,URL,Buffer,setInterval:()=>({fake:true}),clearInterval:()=>{}};
  vm.runInNewContext(compiled,context,{filename:relative});
  return module.exports;
}
// Extract only literal methods from the pinned source, retaining their original bodies.
const entityFile = 'core/entities/NoteEntityService.ts';
const entityAst = ts.createSourceFile(entityFile,source(entityFile),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const entityClass = entityAst.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='NoteEntityService');
const entityMembers = entityClass.members.filter(m=>['shouldHideNote','hideNote'].includes(m.name?.getText(entityAst))).map(m=>m.getText(entityAst)).join('\n');
const EntityOracle = load('entity-oracle.ts',`import {bindThis} from '@/decorators.js';\nimport {shouldHideNoteByTime} from '@/misc/should-hide-note-by-time.js';\nexport class EntityOracle { ${entityMembers} }`).EntityOracle;
const Hiding = load('server/api/stream/NoteStreamingHidingService.ts').NoteStreamingHidingService;
const classes = Object.fromEntries([['main','main','MainChannel'],['homeTimeline','home-timeline','HomeTimelineChannel'],['localTimeline','local-timeline','LocalTimelineChannel'],['globalTimeline','global-timeline','GlobalTimelineChannel'],['hybridTimeline','hybrid-timeline','HybridTimelineChannel']].map(([name,file,cls])=>[name,load(`server/api/stream/channels/${file}.ts`)[cls]]));
const copy = x=>JSON.parse(JSON.stringify(x));
function facts(overrides={}) { return {user:{id:'viewer',isHibernated:false},following:{author:{withReplies:false}},followingChannels:[],mutingChannels:[],mutedInstances:[],muting:[],blockingMe:[],renoteMuting:[],ugc:'all',policies:{ltlAvailable:true,gtlAvailable:true},...overrides}; }
function note(overrides={}) { return {id:'note',userId:'author',user:{id:'author',host:null,requireSigninToViewContents:false,makeNotesHiddenBefore:null},createdAt:'2026-11-06T23:59:00.000Z',text:'text',cw:null,visibility:'public',channelId:null,replyId:null,reply:null,renoteId:null,renote:null,poll:null,fileIds:[],files:[],reactions:{},...overrides}; }
function connection(data) {
  const sent=[];
  const c={user:data.user,userProfile:{mutedInstances:data.mutedInstances},following:data.following,followingChannels:new Set(data.followingChannels),mutingChannels:new Set(data.mutingChannels),userIdsWhoMeMuting:new Set(data.muting),userIdsWhoBlockingMe:new Set(data.blockingMe),userIdsWhoMeMutingRenotes:new Set(data.renoteMuting),subscriber:new EventEmitter(),sendMessageToWs:(type,body)=>sent.push(copy({type,body}))};
  const entity=new EntityOracle();
  entity.meta={ugcVisibilityForVisitor:data.ugc};
  entity.cacheService={userFollowingsCache:{fetch:async()=>data.hidingFollowing??data.following}};
  entity.pack=async(id,viewer,opts)=>({id,oracleRepacked:true,viewer:viewer.id,detail:opts.detail});
  entity.populateMyReaction=async()=>':own:';
  return {c,sent,entity,hiding:new Hiding(entity.meta,entity)};
}
async function runChannel(name,id,data,n,params={}) {
 const {c,sent,entity,hiding}=connection(data);
 const cls=classes[name];
 const args=name==='main'?[entity]:name==='homeTimeline'?[entity,hiding]:[{}, {getUserPolicies:async()=>data.policies},entity,hiding];
 const ch=new cls({id:'channel-id',connection:c},...args);
 await ch.init(params);
 if(name==='main') await ch.onData(copy(n)); else if(c.subscriber.listenerCount('notesStream')) await ch.onNote(copy(n));
 observed.push({id,kind:'channel',input:{channel:name,facts:data,params,payload:n},sent});
 ch.dispose();
 return sent;
}

// Main: the asymmetry is actual source behavior; reply/renote do not run the mention filter.
for(const type of ['notification','mention','reply','renote']) {
 const payload=type==='notification'?{type,body:{id:'notification',userId:'muted',user:{host:'muted.example'},note:note({isHidden:true})}}:{type,body:note({userId:'muted',user:{id:'muted',host:'muted.example'},visibility:'specified',visibleUserIds:['other'],isHidden:true})};
 const sent=await runChannel('main',`main-${type}-muted`,facts({muting:['muted'],mutedInstances:['muted.example']}),payload);
 assert.equal(sent.length,['reply','renote'].includes(type)?1:0);
}
for(const type of ['notification','mention']) {
 const payload=type==='notification'?{type,body:{id:'notification',userId:'author',user:{host:null},note:note({isHidden:true})}}:{type,body:note({isHidden:true})};
 const sent=await runChannel('main',`main-${type}-hidden-repack`,facts(),payload);
 assert.equal(sent.length,1);
 assert.equal(type==='notification'?sent[0].body.body.note.oracleRepacked:sent[0].body.body.oracleRepacked,true);
}

const variations=[
 ['ordinary',facts(),note(),{}],
 ['other-unfollowed',facts({following:{}}),note(),{}],
 ['self',facts({following:{}}),note({userId:'viewer',user:{id:'viewer',host:null}}),{}],
 ['remote-public',facts(),note({user:{id:'author',host:'remote.example'}}),{}],
 ['home',facts(),note({visibility:'home'}),{}],
 ['followers-followed',facts(),note({visibility:'followers'}),{}],
 ['followers-fresh-hide-cache-unfollowed',facts({hidingFollowing:{}}),note({visibility:'followers'}),{}],
 ['followers-unfollowed',facts({following:{}}),note({visibility:'followers'}),{}],
 ['specified-no',facts(),note({visibility:'specified',visibleUserIds:['other']}),{}],
 ['specified-yes',facts(),note({visibility:'specified',visibleUserIds:['viewer']}),{}],
 ['channel-no',facts(),note({channelId:'channel'}),{}],
 ['channel-yes',facts({followingChannels:['channel']}),note({channelId:'channel'}),{}],
 ['withfiles-no',facts(),note(),{withFiles:true}],
 ['withfiles-yes',facts(),note({fileIds:['file']}),{withFiles:true}],
 ['reply-unrelated',facts(),note({replyId:'reply',reply:note({id:'reply',userId:'third',user:{id:'third',host:null}})}),{}],
 ['reply-unrelated-withReplies',facts(),note({replyId:'reply',reply:note({id:'reply',userId:'third',user:{id:'third',host:null}})}),{withReplies:true}],
 ['reply-followingWithReplies',facts({following:{author:{withReplies:true}}}),note({replyId:'reply',reply:note({id:'reply',userId:'third',user:{id:'third',host:null}})}),{}],
 ['reply-followers-target',facts({following:{author:{withReplies:true}}}),note({replyId:'reply',reply:note({id:'reply',userId:'third',user:{id:'third',host:null},visibility:'followers'})}),{}],
 ['reply-to-viewer',facts(),note({replyId:'reply',reply:note({id:'reply',userId:'viewer',user:{id:'viewer',host:null}})}),{}],
 ['mute-author',facts({muting:['author']}),note(),{}],
 ['blocked-by-author',facts({blockingMe:['author']}),note(),{}],
 ['muted-instance',facts({mutedInstances:['remote.example']}),note({user:{id:'author',host:'remote.example'}}),{}],
 ['muted-channel',facts({followingChannels:['channel'],mutingChannels:['channel']}),note({channelId:'channel'}),{}],
 ['pure-renote-off',facts(),note({text:null,renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null}})}),{withRenotes:false}],
 ['quote-renote-off',facts(),note({renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null}})}),{withRenotes:false}],
 ['renote-muted-author',facts({renoteMuting:['author']}),note({text:null,renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null}})}),{}],
 ['pure-renote-myreaction',facts(),note({text:null,renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null},reactions:{':own:':1}})}),{}],
 ['guest-public',facts({user:null,following:{}}),note(),{}],
 ['guest-reply',facts({user:null,following:{}}),note({replyId:'reply',reply:note({id:'reply',userId:'third',user:{id:'third',host:null}})}),{}],
 ['guest-signin-author',facts({user:null,following:{}}),note({user:{id:'author',host:null,requireSigninToViewContents:true}}),{}],
 ['guest-signin-reply',facts({user:null,following:{}}),note({replyId:'reply',reply:note({id:'reply',userId:'third',user:{id:'third',host:null,requireSigninToViewContents:true}})}),{}],
 ['guest-ugc-none',facts({user:null,following:{},ugc:'none'}),note(),{}],
 ['guest-ugc-local-remote',facts({user:null,following:{},ugc:'local'}),note({user:{id:'author',host:'remote.example'}}),{}],
 ['poll-quote-renote-off',facts(),note({text:null,renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null}}),poll:{choices:[]}}),{withRenotes:false}],
 ['reply-quote-renote-off',facts(),note({text:null,renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null}}),replyId:'reply',reply:note({id:'reply',userId:'viewer',user:{id:'viewer',host:null}})}),{withRenotes:false}],
 ['poll-quote-renote-muted',facts({renoteMuting:['author']}),note({text:null,renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null}}),poll:{choices:[]}}),{}],
 ['policy-disabled',facts({policies:{ltlAvailable:false,gtlAvailable:false}}),note(),{}],
];
for(const name of ['homeTimeline','localTimeline','globalTimeline','hybridTimeline']) {
 for(const [id,f,n,p] of variations) {
  if(!f.user&&['homeTimeline','hybridTimeline'].includes(name)) continue; // connect credential gate separately executed below
  await runChannel(name,`${name}-${id}`,f,n,p);
 }
}

// Actual hiding service + extracted actual entity methods, input shared publication must remain unchanged.
const hiddenTarget=note({id:'target',userId:'third',user:{id:'third',host:null},visibility:'specified',visibleUserIds:['other']});
const hidingCases=[
 ['ordinary-visible',facts(),note()],
 ['followers-fresh-hide-cache-unfollowed',facts({hidingFollowing:{}}),note({visibility:'followers'})],
 ['hidden-quote-target',facts(),note({renoteId:'target',renote:hiddenTarget})],
 ['hidden-pure-renote-target',facts(),note({text:null,renoteId:'target',renote:hiddenTarget})],
 ['hidden-poll-quote-target',facts(),note({text:null,renoteId:'target',renote:hiddenTarget,poll:{choices:[]}})],
 ['hidden-reply-quote-target',facts(),note({text:null,renoteId:'target',renote:hiddenTarget,replyId:'reply',reply:note({id:'reply',userId:'viewer',user:{id:'viewer',host:null}})})],
 ['hidden-reply',facts(),note({replyId:'target',reply:hiddenTarget})],
 ['hidden-deep-quote-target',facts(),note({renoteId:'middle',renote:note({id:'middle',renoteId:'target',renote:hiddenTarget})})],
 ['deep-pure-renote-hides-whole',facts(),note({renoteId:'middle',renote:note({id:'middle',text:null,renoteId:'target',renote:hiddenTarget})})],
 ['timed-hidden-author',facts(),note({user:{id:'author',host:null,makeNotesHiddenBefore:Date.parse('2026-11-07')/1000}})],
 ['self-ignores-hidden',facts(),note({userId:'viewer',user:{id:'viewer',host:null,makeNotesHiddenBefore:Date.parse('2026-11-07')/1000}})],
 ['guest-ugc-none',facts({user:null,ugc:'none'}),note()],
 ['guest-ugc-local-remote',facts({user:null,ugc:'local'}),note({user:{id:'author',host:'remote.example'}})],
];
for(const [id,f,n] of hidingCases) {
 const {hiding}=connection(f);const original=copy(n);const output=await hiding.filter(n,f.user?.id??null);
 assert.deepEqual(n,original);
 observed.push({id:`hiding-${id}`,kind:'hiding',input:{facts:f,payload:original},output:copy(output),sharedInputUnchanged:true});
}
assert.equal(observed.find(r=>r.id==='hiding-hidden-pure-renote-target').output,null);
assert.equal(observed.find(r=>r.id==='hiding-hidden-quote-target').output.renote.isHidden,true);


{
 const f=facts();const {c,sent,entity,hiding}=connection(f);let calls=0;
 entity.populateMyReaction=async()=>{if(++calls===1)throw new Error('reaction lookup failed');return ':own:';};
 const channels=['first','second'].map(id=>new classes.homeTimeline({id,connection:c},entity,hiding));
 for(const channel of channels)await channel.init({});
 const n=note({text:null,renoteId:'target',renote:note({id:'target',userId:'third',user:{id:'third',host:null},reactions:{':own:':1}})});
 // EventEmitter invokes each actual callback independently; capture rejected returns to avoid unhandled harness rejection.
 const outcomes=await Promise.allSettled(c.subscriber.listeners('notesStream').map(listener=>listener(copy(n))));
 observed.push({id:'home-channel-reaction-failure-isolated',kind:'channelFailure',input:{facts:f,payload:n,channels:['first','second'],firstReactionFails:true},sent,rejections:outcomes.filter(x=>x.status==='rejected').length});
 assert.equal(sent.length,1);assert.equal(sent[0].body.id,'second');
 for(const channel of channels)channel.dispose();
}

const Connection=load('server/api/stream/Connection.ts').default;
function realConnection(f=facts()) {
 const {c,sent}=connection(f);
 const conn=new Connection({}, {}, {}, {}, {},{ugcVisibilityForVisitor:f.ugc},{user:f.user,token:null});
 const {sendMessageToWs:_send,...state}=c; Object.assign(conn,state);
 conn.wsConnection={readyState:1,send:message=>sent.push(JSON.parse(message))};
 return {conn,sent};
}
for(const [id,f,visibility,visibleUserIds] of [
 ['public',facts({following:{}}),'public',[]],['home',facts({following:{}}),'home',[]],['followers-followed',facts(),'followers',[]],['followers-unfollowed',facts({following:{}}),'followers',[]],['followers-author',facts({user:{id:'author'},following:{}}),'followers',[]],['specified-yes',facts(),'specified',['viewer']],['specified-no',facts(),'specified',['other']],['guest-public',facts({user:null,following:{}}),'public',[]],['guest-followers',facts({user:null,following:{}}),'followers',[]],['guest-ugc-none',facts({user:null,following:{},ugc:'none'}),'public',[]],
]) {
 const {conn,sent}=realConnection(f);const payload={type:'deleted',body:{id:'note',userId:'author',visibility,visibleUserIds,body:{deletedAt:'2026-11-07T00:00:00.000Z'}}};
 await conn.onNoteStreamMessage(payload);
 observed.push({id:`deleted-${id}`,kind:'noteUpdated',input:{facts:f,payload},sent});
 for(const item of sent) assert.deepEqual(Object.keys(item.body).sort(),['body','id','type']);
 conn.dispose();
}
{
 const {conn}=realConnection();
 conn.onSubscribeNote({id:'a'});conn.onSubscribeNote({id:'a'});
 assert.equal(conn.subscriber.listenerCount('noteStream:a'),1);
 conn.onUnsubscribeNote({id:'a'});assert.equal(conn.subscriber.listenerCount('noteStream:a'),1);
 conn.onUnsubscribeNote({id:'a'});assert.equal(conn.subscriber.listenerCount('noteStream:a'),0);
 for(let i=0;i<1536;i++)conn.onSubscribeNote({id:`n${i}`});
 conn.onSubscribeNote({id:'n0'});conn.onSubscribeNote({id:'overflow'});
 assert.equal(conn.subscriber.listenerCount('noteStream:n1'),0);assert.equal(conn.subscriber.listenerCount('noteStream:n0'),1);
 conn.dispose();assert.equal(conn.subscriber.eventNames().length,0);
 observed.push({id:'subscribe-reference-count-lru-dispose',kind:'state',result:{duplicateListeners:1,oneUnsubRetained:true,lastUnsubRemoved:true,limit:1536,overflowEvicted:'n1',recentRetained:'n0',disposeListeners:0}});
}
for(const [id,user,token,ch,pong] of [['main-anon',null,null,'main',true],['main-read-grant',{id:'viewer'},{permission:['read:account']},'main',true],['main-missing-grant',{id:'viewer'},{permission:[]},'main',true],['home-anon',null,null,'homeTimeline',true],['local-anon',null,null,'localTimeline',true],['global-anon',null,null,'globalTimeline',true]]) {
 const {conn,sent}=realConnection(facts({user}));conn.token=token;
 conn.moduleRef={registerRequestByContextId:()=>{},create:async C=>({id:'channel-id',chName:ch,init:async()=>true})};
 await conn.connectChannel('channel-id',{},ch,pong);
 observed.push({id:`connect-${id}`,kind:'connect',input:{user,token,channel:ch,pong},sent,channels:conn.channels.size});conn.dispose();
}


for(const alias of ['subNote','s','sr']) {
 const {conn,sent}=realConnection();
 await conn.onWsConnectionMessage(Buffer.from(JSON.stringify({type:alias,body:{id:'note'}})));
 const subscribed=conn.subscriber.listenerCount('noteStream:note');
 assert.equal(subscribed,1);
 await conn.onWsConnectionMessage(Buffer.from(JSON.stringify({type:'unsubNote',body:{id:'note'}})));
 assert.equal(conn.subscriber.listenerCount('noteStream:note'),0);
 observed.push({id:`alias-${alias}`,kind:'messageAlias',input:{type:alias,body:{id:'note'}},result:{subscribed,unsubscribed:true}});conn.dispose();
}
{
 const {conn}=realConnection();
 await conn.onWsConnectionMessage(Buffer.from(JSON.stringify({type:'s',body:{id:'note'}})));
 await conn.onWsConnectionMessage(Buffer.from(JSON.stringify({type:'un',body:{id:'note'}})));
 assert.equal(conn.subscriber.listenerCount('noteStream:note'),0);
 for(const value of ['bad JSON','null','[]','{}','{"type":"subNote","body":null}','{"type":"subNote","body":{"id":1}}']) {
  // Literal source throws on JSON null destructuring; record rather than hide that fact.
  let error=null;try{await conn.onWsConnectionMessage(Buffer.from(value));}catch(e){error=e.name;}
  observed.push({id:`malformed-${value}`,kind:'messageMalformed',input:value,result:{error,listeners:conn.subscriber.eventNames().length}});
 }
 conn.dispose();
 observed.push({id:'alias-un',kind:'messageAlias',input:{type:'un',body:{id:'note'}},result:{unsubscribed:true}});
}

const Streaming=load('server/api/StreamingApiServerService.ts').StreamingApiServerService;
for(const [id,request,user,app,error,expected] of [
 ['anonymous',{url:'/streaming',headers:{host:'localhost'}},null,null,null,'upgrade'],
 ['query-token',{url:'/streaming?i=query',headers:{host:'localhost'}},{id:'viewer'},null,null,'upgrade'],
 ['header-wins',{url:'/streaming?i=query',headers:{host:'localhost',authorization:'Bearer header'}},{id:'viewer'},null,null,'upgrade'],
 ['invalid-token',{url:'/streaming?i=bad',headers:{host:'localhost'}},null,null,new AuthenticationError('invalid'),'401'],
 ['missing-app-permission',{url:'/streaming?i=app',headers:{host:'localhost'}},{id:'viewer'},{permission:[]},null,'401'],
 ['app-read-account',{url:'/streaming?i=app',headers:{host:'localhost'}},{id:'viewer'},{permission:['read:account']},null,'upgrade'],
 ['suspended',{url:'/streaming?i=user',headers:{host:'localhost'}},{id:'viewer',isSuspended:true},null,null,'403'],
 ['unexpected-auth-failure',{url:'/streaming',headers:{host:'localhost'}},null,null,new Error('DB down'),'500'],
]) {
 let actualToken;const authenticateService={authenticate:async token=>{actualToken=token;if(error)throw error;return[user,app]}};
 const mod={registerRequestByContextId:()=>{},create:async()=>({init:async()=>{}})};
 const streaming=new Streaming(new EventEmitter(),mod,authenticateService,{});const server=new EventEmitter();streaming.attach(server);
 const writes=[];const socket={write:x=>writes.push(x),destroy:()=>{}};
 await server.listeners('upgrade')[0](request,socket,Buffer.alloc(0));
 const status=fakeServer.upgrades.length?'upgrade':writes.join('').slice(9,12);
 assert.equal(status,expected);
 observed.push({id:`upgrade-${id}`,kind:'upgrade',input:{request,user,app,error:error?.constructor.name??null},result:{token:actualToken,status,writes}});
 await streaming.detach();
}
const output={upstreamCommit:sha,executedFromGitObjects:true,limitations:['Narrow DI/cache/transport doubles; no old HTTP server or DB/Redis/worker execution.','pack and populateMyReaction are doubles; their return calls are observed, not old pack equivalence.','NoteEntityService shouldHideNote/hideNote bodies extracted verbatim from pinned source; imports bindThis/time helper execute literal pinned modules.','Fake timer registrations only; heartbeat timing not executed.'],blobs:[...blobs].map(([file,{blob}])=>({file,blob})),observations:observed};
const outputFile=process.env.OUTPUT_FILE??'/tmp/backend-next-stream-source-observations.json';writeFileSync(outputFile,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({upstreamCommit:sha,sourceFiles:blobs.size,observations:observed.length,kinds:Object.fromEntries([...new Set(observed.map(o=>o.kind))].map(k=>[k,observed.filter(o=>o.kind===k).length])),outputFile}));
