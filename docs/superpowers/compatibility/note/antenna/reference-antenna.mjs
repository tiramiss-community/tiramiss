/* SPDX-FileCopyrightText: 2026 tiramiss-community */
/* SPDX-License-Identifier: AGPL-3.0-only */
// Execute actual pinned method bodies; repositories, Redis, clocks and unrelated services are doubles.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { domainToASCII, fileURLToPath } from 'node:url';
import vm from 'node:vm';
const sha = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT;
assert(root, 'Set UPSTREAM_ROOT to a Git checkout containing the pinned source');
const repository = process.env.REPOSITORY_ROOT || fileURLToPath(new URL('../../../../../', import.meta.url));
const require = createRequire(path.join(repository, 'package.json'));
const ts = require('typescript');
const output = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(tmpdir(), 'antenna-reference-'));
fs.mkdirSync(output, { recursive: true });
const sources = new Map();
const NOW = 1794054896000;
let random = 0.5;
const clone = x => JSON.parse(JSON.stringify(x));
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Clock extends Date { static now() { return NOW; } }
function source(file) {
	if (!sources.has(file)) sources.set(file, {
		text: execFileSync('git', ['-C', root, 'show', `${sha}:${file}`], { encoding: 'utf8' }),
		blob: execFileSync('git', ['-C', root, 'rev-parse', `${sha}:${file}`], { encoding: 'utf8' }).trim(),
	});
	return sources.get(file).text;
}
function declaration(file, name) {
	const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
	const node = ast.statements.find(n => n.name?.text === name);
	assert(node, name); return { ast, node };
}
function methods(file, name, names) {
	const { ast, node } = declaration(file, name);
	const selected = node.members.filter(n => names.includes(n.name?.getText(ast)));
	assert.equal(selected.length, names.length);
	return selected.map(n => n.getText(ast)).join('\n');
}
let bindThis;
function compile(text, filename, extra = {}) {
	const module = { exports: {} }, math = Object.create(Math); math.random = () => random;
	vm.runInNewContext(ts.transpileModule(text, { compilerOptions: {
		target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
	} }).outputText, { module, exports: module.exports, Date: Clock, Math: math, Promise, Set, Map,
		bindThis, Injectable: () => x => x, Inject: () => () => {}, DI: new Proxy({}, { get: (_, x) => x }),
		domainToASCII, In: x => x, trackPromise: () => {}, ...extra }, { filename });
	return module.exports;
}
const decoratorFile = 'packages/backend/src/decorators.ts';
bindThis = compile(source(decoratorFile), decoratorFile).bindThis;
const antennaFile = 'packages/backend/src/core/AntennaService.ts';
const utilityFile = 'packages/backend/src/core/UtilityService.ts';
const acctFile = 'packages/backend/src/misc/acct.ts';
const fanoutFile = 'packages/backend/src/core/FanoutTimelineService.ts';
const globalFile = 'packages/backend/src/core/GlobalEventService.ts';
const createFile = 'packages/backend/src/core/NoteCreateService.ts';
const deleteFile = 'packages/backend/src/core/NoteDeleteService.ts';
const Acct = compile(source(acctFile), acctFile);
const utility = Object.assign(new (compile(`export class Utility {${methods(utilityFile, 'UtilityService', ['getFullApAccount', 'toPuny'])}}`, utilityFile).Utility)(), { config: { host: 'local.example' } });
const antennaDeclaration = declaration(antennaFile, 'AntennaService');
const Antenna = compile(antennaDeclaration.node.getText(antennaDeclaration.ast), antennaFile, { Acct }).AntennaService;
const Fanout = compile(`export class Fanout {${methods(fanoutFile, 'FanoutTimelineService', ['push'])}}`, fanoutFile).Fanout;
const Global = compile(`export class Global {${methods(globalFile, 'GlobalEventService', ['publish', 'publishAntennaStream'])}}`, globalFile).Global;
const manager = declaration(createFile, 'NotificationManager');
const Post = compile(`${manager.node.getText(manager.ast)}\nexport class Post {${methods(createFile, 'NoteCreateService', ['postNoteCreated'])}}`, createFile).Post;
const Delete = compile(`export class Delete {${methods(deleteFile, 'NoteDeleteService', ['delete'])}}`, deleteFile, { isRenote: () => false, isQuote: () => false }).Delete;
const baseAntenna = { id: 'antenna', userId: 'owner', src: 'all', users: [], userListId: null, keywords: [], excludeKeywords: [], caseSensitive: false, withReplies: true, withFile: false, localOnly: false, excludeBots: false, excludeNotesInSensitiveChannel: false, expression: null, isActive: true, lastUsedAt: '2026-11-07T00:00:00.000Z' };
const baseNote = { id: String(NOW), userId: 'author', userHost: null, visibility: 'public', visibleUserIds: [], text: 'Hello', cw: null, fileIds: [], replyId: null, renoteId: null, channelId: null, localOnly: true };
const baseUser = { id: 'author', username: 'Alice', host: null, isBot: false };
function setup({ antennas = [baseAntenna], followingIds = [], listMember = false, mode = 'ok', tail = null } = {}) {
	const calls = [], held = deferred(), subscriber = new EventEmitter();
	const record = (method, body = {}) => calls.push({ method, ...clone(body) });
	const state = { antennas: clone(antennas), followingIds, listMember, tail, mode };
	const pipeline = { lpush: (key, id) => record('pipeline.lpush', { key, id }), ltrim: (key, start, end) => record('pipeline.ltrim', { key, start, end }), exec: () => {
		record('pipeline.exec'); if (state.mode === 'hold-exec') return held.promise;
		if (state.mode === 'reject-exec') return Promise.reject(new Error('exec failed'));
		return Promise.resolve(state.mode === 'command-error' ? [[new Error('command failed'), null]] : [[null, 1]]);
	} };
	const redis = { pipeline: () => { record('pipeline'); return pipeline; }, lindex: async (key, index) => {
		record('lindex', { key, index }); if (state.mode === 'hold-lindex') await held.promise;
		if (state.mode === 'reject-lindex') throw new Error('lindex failed'); return state.tail;
	}, lpush: async (key, id) => { record('direct.lpush', { key, id }); if (state.mode === 'reject-direct') throw new Error('direct failed'); } };
	const antennasRepository = { findBy: async query => {
		record('readAntennas', { query }); const result = clone(state.antennas.filter(a => a.isActive));
		if (state.mode === 'hold-fetch') await held.promise; if (state.mode === 'reject-fetch') throw new Error('fetch failed'); return result;
	} };
	const memberships = { exists: async query => { record('readList', { query }); if (state.mode === 'hold-list') await held.promise; if (state.mode === 'reject-list') throw new Error('list failed'); return state.listMember; } };
	const cache = { userFollowingsCache: { fetch: async userId => { record('readFollowings', { userId }); if (state.mode === 'reject-follow') throw new Error('follow failed'); return Object.fromEntries(state.followingIds.map(id => [id, {}])); } } };
	const global = { publishAntennaStream: (id, type, note) => {
		record('antennaPublication', { antennaId: id, type, note }); if (state.mode === 'throw-publication') throw new Error('publication threw');
		if (state.mode === 'hold-publication') return held.promise; if (state.mode === 'reject-publication') return Promise.reject(new Error('publication failed'));
	} };
	const fanout = Object.assign(new Fanout(), { redisForTimelines: redis, idService: { parse: id => ({ date: new Date(Number(id)) }) } });
	const antenna = new Antenna(redis, subscriber, antennasRepository, memberships, cache, utility, global, fanout);
	return { antenna, calls, state, held, subscriber, record, event: (type, body) => subscriber.emit('message', 'irrelevant-transport-channel', JSON.stringify({ channel: 'internal', message: { type, body } })) };
}
function postContext(f, { packFail = false, mentionFail = false } = {}) {
	const post = new Post(), rec = method => f.record(method);
	Object.assign(post, { notesChart: { update: () => rec('notesChart') }, perUserNotesChart: { update() {} }, meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false },
		hashtagService: { updateHashtags() {} }, incNotesCountOfUser: () => rec('count-start'), pushToTl: () => rec('other-timelines-start'), antennaService: f.antenna,
		saveReply() {}, followingsRepository: { findBy: async () => [] }, isRenote: d => !!d.renote, isQuote: () => false, incRenoteCount() {},
		queueService: { endedPollNotificationQueue: { add() {} } }, userEntityService: { isLocalUser: u => u.host == null, isRemoteUser: u => u.host != null }, activeUsersChart: { write() {} },
		noteEntityService: { pack: async n => { rec('pack'); if (packFail) throw new Error('pack failed'); return { ...n, packed: true }; } },
		globalEventService: { publishNotesStream: () => rec('notesPublication'), publishMainStream() {} }, roleService: { addNoteToRoleTimeline() {} }, webhookService: { enqueueUserWebhook() {} },
		createMentionedEvents: async () => { rec('mention-preparation'); if (mentionFail) throw new Error('mention failed'); },
		noteThreadMutingsRepository: { exists: async () => false }, channelsRepository: { increment: async () => {}, update: async () => {} }, notesRepository: { countBy: async () => 2 },
		renderNoteOrRenoteActivity: async () => ({}), apDeliverManagerService: { createDeliverManager: () => ({ addFollowersRecipe() {}, execute: async () => {} }) }, relayService: { deliverToRelays() {} }, index: () => rec('index-start') });
	return post;
}
const observations = [];
async function capture(id, run) {
	const unhandled = [], listener = e => unhandled.push(e?.message ?? String(e)); process.on('unhandledRejection', listener);
	try { const value = await run(); await tick(); await tick(); observations.push({ id, ...value, unhandledRejectionsCapturedByHarness: unhandled }); }
	finally { process.off('unhandledRejection', listener); random = 0.5; }
}
async function match(id, antenna = {}, note = {}, noteUser = {}, followingIds = [], listMember = false, expected) {
	await capture(`match-${id}`, async () => {
		const input = { antenna: { ...baseAntenna, ...antenna }, note: { ...baseNote, ...note }, noteUser: { ...baseUser, ...noteUser }, followingIds, listMember };
		const f = setup(input), hit = await f.antenna.checkHitAntenna(input.antenna, input.note, input.noteUser);
		if (expected !== undefined) assert.equal(hit, expected, id); return { input: clone(input), hit, calls: f.calls };
	});
}
for (const flag of [false, true]) for (const present of [false, true]) {
	await match(`sensitive-${flag}-${present}`, { excludeNotesInSensitiveChannel: flag }, { channel: { isSensitive: present } }, {}, [], false, !(flag && present));
	await match(`bot-${flag}-${present}`, { excludeBots: flag }, {}, { isBot: present }, [], false, !(flag && present));
	await match(`local-${flag}-${present}`, { localOnly: flag }, {}, { host: present ? 'remote.example' : null }, [], false, !(flag && present));
	await match(`reply-${flag}-${present}`, { withReplies: flag }, { replyId: present ? 'reply' : null }, {}, [], false, flag || !present);
}
for (const visibility of ['public', 'home', 'followers', 'specified']) for (const own of [false, true]) for (const following of [false, true]) for (const visible of [false, true]) {
	await match(`visibility-${visibility}-own${own}-following${following}-visible${visible}`, { userId: own ? 'author' : 'owner' }, { visibility, visibleUserIds: visible ? ['owner'] : [] }, {}, following ? ['author'] : [], false, visibility === 'followers' ? own || following : visibility === 'specified' ? own || visible : true);
}
for (const src of ['all', 'home', 'users', 'users_blacklist', 'list']) for (const found of [false, true]) await match(`source-${src}-${found}`, { src, userListId: 'list', users: found ? ['@alice@LOCAL.EXAMPLE'] : ['other'] }, {}, {}, [], found, src === 'users' || src === 'list' ? found : src === 'users_blacklist' ? !found : true);
const extras = [
	['list-null', { src: 'list' }, {}, {}, false], ['local-short', { src: 'users', users: ['alice'] }, {}, {}, true],
	['local-explicit', { src: 'users', users: ['alice@local.example'] }, {}, {}, true], ['remote-not-local', { src: 'users', users: ['alice'] }, {}, { host: 'remote.example' }, false],
	['idna', { src: 'users', users: ['@ALICE@xn--r8jz45g.xn--zckzah'] }, {}, { host: '例え.テスト' }, true],
	['specified-no-visible-array', {}, { visibility: 'specified', visibleUserIds: undefined }, {}, false],
	['exclude-only-null', { excludeKeywords: [['missing']] }, { text: null, cw: null }, {}, false], ['exclude-only-empty', { excludeKeywords: [['missing']] }, { text: '', cw: null }, {}, true],
	['empty-cleanup', { keywords: [[''], []], excludeKeywords: [[''], []] }, { text: null, cw: null }, {}, true], ['include-null', { keywords: [['Hello']] }, { text: null, cw: null }, {}, false],
	['cw-order', { keywords: [['Hello\nWorld']] }, { cw: 'World' }, {}, true], ['cw-alone', { keywords: [['World']] }, { text: null, cw: 'World' }, {}, true],
	['no-reverse-order', { keywords: [['World\nHello']] }, { cw: 'World' }, {}, false], ['spaces-preserved', { keywords: [[' ']] }, { text: 'x', cw: 'y' }, {}, false],
	['case-sensitive', { keywords: [['hello']], caseSensitive: true }, {}, {}, false], ['case-fold', { keywords: [['hello']] }, {}, {}, true],
	['and', { keywords: [['Hello', 'World']] }, { cw: 'World' }, {}, true], ['and-missing', { keywords: [['Hello', 'World']] }, {}, {}, false], ['or', { keywords: [['missing'], ['Hello']] }, {}, {}, true],
	['literal', { keywords: [['/Hello/']] }, {}, {}, false], ['exclude-and', { excludeKeywords: [['Hello', 'World']] }, { cw: 'World' }, {}, false], ['exclude-and-missing', { excludeKeywords: [['Hello', 'World']] }, {}, {}, true],
	['exclude-or', { excludeKeywords: [['missing'], ['Hello']] }, {}, {}, false], ['file-empty', { withFile: true }, { fileIds: [] }, {}, false], ['file-undefined', { withFile: true }, { fileIds: undefined }, {}, true], ['file-present', { withFile: true }, { fileIds: ['f'] }, {}, true],
	['expression-ignored', { expression: 'false' }, {}, {}, true], ['channelid-insufficient', { excludeNotesInSensitiveChannel: true }, { channelId: 'sensitive' }, {}, true],
	['renote-target-not-searched', { keywords: [['target']] }, { text: null, renoteId: 'r', renote: { text: 'target' } }, {}, false],
];
for (const [id, a, n, u, expected] of extras) await match(id, a, n, u, [], false, expected);
for (const age of [179999, 180000, 180001]) for (const tail of [null, NOW - 180002, NOW - age, NOW]) for (const roll of [0.099999, 0.1]) await capture(`producer-age${age}-tail${tail}-random${roll}`, async () => {
	random = roll; const f = setup({ tail: tail === null ? null : String(tail) }), note = { ...baseNote, id: String(NOW - age) };
	await f.antenna.addNoteToAntennas(note, baseUser); await tick(); return { input: { note, noteUser: baseUser, antenna: baseAntenna, tail, now: NOW, random: roll }, calls: f.calls };
});
await capture('producer-empty', async () => { const f = setup({ antennas: [] }); await f.antenna.addNoteToAntennas(baseNote, baseUser); assert.deepEqual(f.calls.map(c => c.method), ['readAntennas', 'pipeline', 'pipeline.exec']); return { calls: f.calls }; });
await capture('producer-repeat-no-dedup', async () => { const f = setup(); await f.antenna.addNoteToAntennas(baseNote, baseUser); await f.antenna.addNoteToAntennas(baseNote, baseUser); assert.equal(f.calls.filter(c => c.method === 'pipeline.lpush').length, 2); return { calls: f.calls }; });
for (const visibility of ['public', 'home', 'followers', 'specified']) for (const remote of [false, true]) for (const silent of [false, true]) for (const packFail of [false, true]) await capture(`post-${visibility}-remote${remote}-silent${silent}-packFail${packFail}`, async () => {
	const f = setup({ antennas: [{ ...baseAntenna, userId: 'author' }] }), note = { ...baseNote, visibility, userHost: remote ? 'remote.example' : null }, user = { ...baseUser, host: note.userHost };
	let error; try { await postContext(f, { packFail }).postNoteCreated(note, user, { visibility, localOnly: true }, silent, [], []); } catch (e) { error = e.message; }
	await tick(); assert.equal(f.calls.filter(c => c.method === 'antennaPublication').length, 1); return { input: { visibility, remote, silent, packFail }, calls: f.calls, ...(error ? { error } : {}) };
});
for (const mode of ['hold-fetch', 'hold-list', 'hold-exec', 'hold-publication', 'hold-lindex', 'reject-fetch', 'reject-list', 'reject-follow', 'reject-exec', 'reject-publication', 'reject-lindex', 'reject-direct', 'throw-publication', 'command-error']) await capture(`lifetime-${mode}`, async () => {
	const antenna = mode.includes('list') ? { ...baseAntenna, src: 'list', userListId: 'list' } : baseAntenna;
	const f = setup({ mode, antennas: [antenna], listMember: true }), note = { ...baseNote, ...(mode.includes('lindex') || mode.includes('direct') ? { id: String(NOW - 180000) } : {}), ...(mode === 'reject-follow' ? { visibility: 'followers' } : {}) };
	let returned = false, error; const pending = f.antenna.addNoteToAntennas(note, baseUser).then(() => { returned = true; f.record('add-returned'); }, e => { returned = true; error = e.message; f.record('add-rejected', { error }); });
	let returnedBeforeRelease;
	try {
		await tick(); returnedBeforeRelease = returned;
		if (mode === 'hold-fetch' || mode === 'hold-list') assert(!returned); else if (mode.startsWith('hold-')) assert(returned);
	} finally { f.held.resolve([]); await pending; await tick(); await tick(); }
	return { input: { mode }, returnedBeforeRelease, ...(error ? { error } : {}), calls: f.calls };
});
await capture('producer-matcher-reject-all-or-nothing', async () => {
	const f = setup({ mode: 'reject-list', antennas: [baseAntenna, { ...baseAntenna, id: 'list', src: 'list', userListId: 'list' }] });
	let error; try { await f.antenna.addNoteToAntennas(baseNote, baseUser); } catch (e) { error = e.message; }
	assert(!f.calls.some(c => c.method === 'pipeline')); return { error, calls: f.calls };
});
for (const mode of ['hold-fetch', 'reject-fetch', 'reject-exec', 'throw-publication']) await capture(`post-boundary-${mode}`, async () => {
	const f = setup({ mode });
	const pending = postContext(f).postNoteCreated(baseNote, baseUser, { visibility: 'public', localOnly: true }, false, [], []);
	try { await pending; f.record('post-returned'); assert(f.calls.some(c => c.method === 'index-start')); }
	finally { f.held.resolve(); await pending; await tick(); await tick(); }
	return { calls: f.calls };
});
await capture('post-boundary-mention-reject', async () => { const f = setup(); let error; try { await postContext(f, { mentionFail: true }).postNoteCreated(baseNote, baseUser, { visibility: 'public', localOnly: true }, false, [], []); } catch (e) { error = e.message; } await tick(); assert(f.calls.some(c => c.method === 'antennaPublication')); assert(!f.calls.some(c => c.method === 'index-start')); return { error, calls: f.calls }; });
await capture('cache-active-initial-and-db-only-stale', async () => { const f = setup({ antennas: [baseAntenna, { ...baseAntenna, id: 'inactive', isActive: false }] }); await f.antenna.getAntennas(); f.state.antennas = []; await f.antenna.addNoteToAntennas(baseNote, baseUser); assert.equal(f.calls.filter(c => c.method === 'readAntennas').length, 1); assert.equal(f.calls.filter(c => c.method === 'antennaPublication').length, 1); return { calls: f.calls }; });
await capture('cache-event-create-update-delete', async () => {
	const f = setup({ antennas: [] }); await f.antenna.getAntennas();
	for (const type of ['antennaCreated', 'antennaCreated', 'antennaUpdated']) f.event(type, { ...baseAntenna, isActive: false });
	const afterDuplicates = clone(await f.antenna.getAntennas()); assert.equal(afterDuplicates.length, 2);
	f.event('antennaUpdated', { ...baseAntenna, id: 'upsert', isActive: false }); await f.antenna.addNoteToAntennas(baseNote, baseUser);
	f.event('antennaDeleted', { id: 'antenna' }); const afterDelete = clone(await f.antenna.getAntennas()); assert.equal(afterDelete.length, 1);
	assert.equal(f.calls.filter(c => c.method === 'antennaPublication').length, 3); return { afterDuplicates, afterDelete, calls: f.calls };
});
for (const duringFetch of [false, true]) await capture(`cache-event-overwritten-duringFetch${duringFetch}`, async () => {
	const f = setup({ mode: duringFetch ? 'hold-fetch' : 'ok', antennas: [] }); let pending;
	try {
		if (duringFetch) pending = f.antenna.getAntennas(); f.event('antennaCreated', baseAntenna);
		if (!duringFetch) pending = f.antenna.getAntennas();
	} finally { f.held.resolve(); await pending; await tick(); await tick(); }
	assert.equal((await f.antenna.getAntennas()).length, 0); return { calls: f.calls };
});
await capture('cache-concurrent-cold-no-singleflight', async () => {
	const f = setup({ mode: 'hold-fetch' }); const a = f.antenna.getAntennas(), b = f.antenna.getAntennas();
	try { assert.equal(f.calls.length, 2); }
	finally { f.held.resolve(); await Promise.all([a, b]); await tick(); await tick(); }
	return { calls: f.calls };
});
await capture('cache-retry-after-initial-fetch-reject', async () => { const f = setup({ mode: 'reject-fetch' }); let error; try { await f.antenna.getAntennas(); } catch (e) { error = e.message; } f.state.mode = 'ok'; await f.antenna.getAntennas(); assert.equal(f.calls.filter(c => c.method === 'readAntennas').length, 2); return { error, calls: f.calls }; });
await capture('producer-multiple-definition-order', async () => { const f = setup({ antennas: [{ ...baseAntenna, id: 'second' }, { ...baseAntenna, id: 'first' }] }); await f.antenna.addNoteToAntennas(baseNote, baseUser); assert.deepEqual(f.calls.filter(c => c.method === 'antennaPublication').map(c => c.antennaId), ['second', 'first']); return { calls: f.calls }; });
await capture('post-channel-snapshot-before-pack', async () => { const f = setup(); const channel = { id: 'channel', isSensitive: true, allowRenoteToExternal: false, name: 'raw channel' }; await assert.rejects(postContext(f, { packFail: true }).postNoteCreated({ ...baseNote, channelId: channel.id }, baseUser, { visibility: 'public', localOnly: true, channel }, false, [], []), /pack failed/); await tick(); assert.deepEqual(f.calls.find(c => c.method === 'antennaPublication').note.channel, channel); return { calls: f.calls }; });
await capture('cache-dispose-detaches-listener', async () => { const f = setup({ antennas: [] }); await f.antenna.getAntennas(); assert.equal(f.subscriber.listenerCount('message'), 1); f.antenna.dispose(); f.event('antennaCreated', baseAntenna); assert.equal((await f.antenna.getAntennas()).length, 0); return { listenerCount: f.subscriber.listenerCount('message'), calls: f.calls }; });
for (const quiet of [false, true]) for (const dbFails of [false, true]) await capture(`delete-no-antenna-cleanup-quiet${quiet}-dbFails${dbFails}`, async () => {
	const f = setup(), del = new Delete(); Object.assign(del, { notesRepository: { delete: async () => { f.record('dbDelete'); if (dbFails) throw new Error('delete failed'); } }, searchService: { unindexNote: () => f.record('searchUnindex') }, globalEventService: { publishNoteStream: () => f.record('noteDeletedPublication') }, notesChart: { update() {} }, perUserNotesChart: { update() {} }, meta: { enableStatsForFederatedInstances: false }, userEntityService: { isLocalUser: () => true }, antennaService: f.antenna });
	let error; try { await del.delete(baseUser, baseNote, quiet); } catch (e) { error = e.message; } assert(!f.calls.some(c => c.method === 'pipeline')); return { input: { quiet, dbFails }, calls: f.calls, ...(error ? { error } : {}) };
});
await capture('global-publication-wire', async () => { const calls = []; const g = Object.assign(new Global(), { config: { host: 'local.example' }, redisForPub: { publish: (channel, data) => { calls.push({ channel, payload: JSON.parse(data) }); return Promise.resolve(1); } } }); g.publishAntennaStream('antenna', 'note', baseNote); assert.equal(calls[0].payload.channel, 'antennaStream:antenna'); return { calls }; });
let databaseEvidence = { executed: false, reason: 'Set SOURCE_PG_URL to a dedicated PostgreSQL test administrator connection for actual insert payload probes.' };
if (process.env.SOURCE_PG_URL) {
	const dependencies = createRequire(path.join(root, 'packages/backend/package.json'));
	const typeorm = dependencies('typeorm'), { Client } = dependencies('pg');
	const typeormDirectory = path.dirname(dependencies.resolve('typeorm'));
	const installedVersion = JSON.parse(fs.readFileSync(path.join(typeormDirectory, 'package.json'), 'utf8')).version;
	assert.equal(installedVersion, JSON.parse(source('packages/backend/package.json')).dependencies.typeorm);
	const packageEvidence = Object.fromEntries(['query-builder/InsertQueryBuilder.js', 'query-builder/ReturningResultsEntityUpdator.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(typeormDirectory, file))).digest('hex')]));
	const idFile = 'packages/backend/src/models/util/id.ts', typesFile = 'packages/backend/src/types.ts';
	const noteFile = 'packages/backend/src/models/Note.ts', channelFile = 'packages/backend/src/models/Channel.ts';
	const id = compile(source(idFile), idFile).id;
	const typeAst = ts.createSourceFile(typesFile, source(typesFile), ts.ScriptTarget.Latest, true);
	const constants = typeAst.statements.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ['noteVisibilities', 'noteReactionAcceptances'].includes(d.name.getText(typeAst)))).map(n => n.getText(typeAst)).join('\n');
	const types = compile(constants, typesFile);
	class MiUser {} class MiDriveFile {}
	for (const [entity, name] of [[MiUser, 'source_probe_user'], [MiDriveFile, 'source_probe_drive_file']]) { typeorm.Entity(name)(entity); typeorm.PrimaryColumn('varchar')(entity.prototype, 'id'); }
	const channelDecl = declaration(channelFile, 'MiChannel');
	const MiChannel = compile(channelDecl.node.getText(channelDecl.ast), channelFile, { ...typeorm, id, MiUser, MiDriveFile }).MiChannel;
	const noteDecl = declaration(noteFile, 'MiNote');
	const MiNote = compile(noteDecl.node.getText(noteDecl.ast), noteFile, { ...typeorm, ...types, id, MiUser, MiChannel }).MiNote;
	const normalizeFile = 'packages/backend/src/misc/normalize-for-search.ts';
	const normalizeForSearch = compile(source(normalizeFile), normalizeFile).normalizeForSearch;
	const Insert = compile(`export class Insert {${methods(createFile, 'NoteCreateService', ['insertNote'])}}`, createFile, { MiNote, normalizeForSearch, isDuplicateKeyValueError: () => false, console }).Insert;
	const database = `backend_next_antenna_source_${process.pid}_${Date.now()}`;
	const admin = new Client({ connectionString: process.env.SOURCE_PG_URL }); await admin.connect();
	let ds;
	try {
		await admin.query(`CREATE DATABASE "${database}"`);
		const url = new URL(process.env.SOURCE_PG_URL); url.pathname = `/${database}`;
		ds = new typeorm.DataSource({ type: 'postgres', url: url.href, entities: [MiNote, MiChannel, MiUser, MiDriveFile], synchronize: true });
		await ds.initialize(); await ds.getRepository(MiUser).insert({ id: 'author' });
		const channelRepo = ds.getRepository(MiChannel), noteRepo = ds.getRepository(MiNote);
		await channelRepo.insert({ id: 'channel', userId: 'author', name: 'Source channel', description: 'creation-time raw channel', isSensitive: true, allowRenoteToExternal: false });
		const channel = await channelRepo.findOneByOrFail({ id: 'channel' });
		let serial = 0;
		const insert = Object.assign(new Insert(), { idService: { gen: () => String(NOW + serial++) }, notesRepository: noteRepo, userProfilesRepository: { findBy: async () => [{ userId: 'remote-mention', url: 'https://remote.example/profile' }] }, userEntityService: { isRemoteUser: u => u.host != null } });
		const dataBase = { text: 'Hello', localOnly: true, visibility: 'public' };
		const targetSaved = await insert.insertNote(baseUser, { ...dataBase, text: 'Target body' }, [], [], []);
		const target = await noteRepo.findOneByOrFail({ id: targetSaved.id });
		for (const [name, data, mentions] of [
			['basic', dataBase, []],
			['mention', dataBase, [{ id: 'remote-mention', username: 'Other', host: 'remote.example', uri: 'https://remote.example/users/other' }]],
			['reply', { ...dataBase, reply: target }, []],
			['renote', { ...dataBase, text: null, renote: target }, []],
			['channel', { ...dataBase, channel }, []],
		]) await capture(`payload-actual-pg-${name}`, async () => {
			const saved = await insert.insertNote(baseUser, data, ['ＴＡＧ'], [], mentions);
			const reloaded = await noteRepo.findOneByOrFail({ id: saved.id });
			const f = setup(); await postContext(f).postNoteCreated(saved, baseUser, data, false, [], []); await tick();
			const publication = f.calls.find(c => c.method === 'antennaPublication'); assert(publication);
			assert.equal(publication.note.renoteCount, 0); assert.equal(publication.note.mentionedRemoteUsers, name === 'mention' ? JSON.stringify([{ uri: 'https://remote.example/users/other', url: 'https://remote.example/profile', username: 'Other', host: 'remote.example' }]) : '[]');
			assert.equal(Object.hasOwn(publication.note, 'uri'), false);
			assert.equal(reloaded.uri, null);
			assert.deepEqual(publication.note.channel, data.channel ? clone(channel) : null);
			return { input: { name, data: clone(data), mentions }, saved: clone(saved), reloaded: clone(reloaded), publication: publication.note, calls: f.calls };
		});
		databaseEvidence = { executed: true, typeormVersion: installedVersion, typeormFilesSha256: packageEvidence, postgresVersion: (await ds.query('SHOW server_version'))[0].server_version, scope: 'Actual pinned Note/Channel decorators and NoteCreateService.insertNote with actual TypeORM/PostgreSQL insert, reload and full postNoteCreated; only User/DriveFile relation targets are minimal probe entities. No upstream full server, HTTP or real Redis.' };
	} finally { if (ds?.isInitialized) await ds.destroy(); await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
}
const result = { fixedCommit: sha, evidence: 'Actual full AntennaService class including constructor/listener/dispose; actual bindThis, Acct, Utility account functions, Fanout push, Global publish, complete postNoteCreated/NotificationManager and NoteDeleteService.delete. Repositories, Redis, clock/random and unrelated services doubled except the explicitly labelled actual PostgreSQL payload probes. No upstream full server or real Redis.', databaseEvidence, sources: Object.fromEntries([...sources].map(([file, { blob }]) => [file, { blob }])), observations };
fs.writeFileSync(path.join(output, 'observations.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cases: observations.length, output: path.join(output, 'observations.json') }));
