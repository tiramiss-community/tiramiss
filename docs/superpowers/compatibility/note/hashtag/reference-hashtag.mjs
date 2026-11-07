/* SPDX-FileCopyrightText: 2026 tiramiss-community */
/* SPDX-License-Identifier: AGPL-3.0-only */
// Execute pinned upstream method bodies; external services and persistence are doubles.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const sha = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT;
assert(root, 'Set UPSTREAM_ROOT to a repository containing the pinned commit');
const repository = process.env.REPOSITORY_ROOT || fileURLToPath(new URL('../../../../../', import.meta.url));
const require = createRequire(path.join(repository, 'package.json'));
const dependencies = createRequire(path.join(repository, 'packages/backend-next/package.json'));
const ts = require('typescript');
const mfm = dependencies('mfm-js');
const RE2 = dependencies('re2');
const output = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(tmpdir(), 'hashtag-reference-'));
fs.mkdirSync(output, { recursive: true });
const sources = new Map();
process.env.TZ = 'UTC';
const NOW = Date.parse('2026-11-07T12:34:56Z');
const EPOCH = Date.parse('2023-01-01T00:00:00Z');
let now = NOW;
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
class Clock extends Date {
	constructor(...args) { super(...(args.length ? args : [now])); }
	static now() { return now; }
}
function source(file) {
	if (!sources.has(file)) {
		const text = execFileSync('git', ['-C', root, 'show', `${sha}:${file}`], { encoding: 'utf8' });
		const blob = execFileSync('git', ['-C', root, 'rev-parse', `${sha}:${file}`], { encoding: 'utf8' }).trim();
		sources.set(file, { text, blob });
	}
	return sources.get(file).text;
}
function declaration(file, name) {
	const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
	const node = ast.statements.find(n => (ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name?.text === name);
	assert(node, name); return { ast, node };
}
function methods(file, name, names) {
	const { ast, node } = declaration(file, name);
	const selected = node.members.filter(n => names.includes(n.name?.getText(ast)));
	assert.equal(selected.length, names.length);
	return selected.map(n => n.getText(ast)).join('\n');
}
function functionText(file, name) { const { ast, node } = declaration(file, name); return node.getText(ast); }
function compile(text, filename, extra = {}) {
	const module = { exports: {} };
	vm.runInNewContext(ts.transpileModule(text, { compilerOptions: {
		target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
	} }).outputText, { module, exports: module.exports, Date: Clock, Promise, Set, Map, AbortController,
		bindThis: () => {}, trackPromise: () => {}, RE2, mfm, unique: values => [...new Set(values)],
		concat: values => values.flat(), isRenote: () => false, isQuote: () => false,
		MiNote: class { constructor(value) { Object.assign(this, value); } },
		MiPoll: class { constructor(value) { Object.assign(this, value); } },
		In: value => value, isDuplicateKeyValueError: () => false,
		setImmediate: () => Promise.resolve(),
		console: { error() {} }, ...extra }, { filename });
	return module.exports;
}
const createFile = 'packages/backend/src/core/NoteCreateService.ts';
const hashtagFile = 'packages/backend/src/core/HashtagService.ts';
const featuredFile = 'packages/backend/src/core/FeaturedService.ts';
const deleteFile = 'packages/backend/src/core/NoteDeleteService.ts';
const normalizeFile = 'packages/backend/src/misc/normalize-for-search.ts';
const normalizeForSearch = compile(functionText(normalizeFile, 'normalizeForSearch'), normalizeFile).normalizeForSearch;
const extractFile = 'packages/backend/src/misc/extract-hashtags.ts';
const arrayFile = 'packages/backend/src/misc/prelude/array.ts';
const array = compile(`${functionText(arrayFile, 'unique')}\n${functionText(arrayFile, 'concat')}`, arrayFile);
const extractHashtags = compile(functionText(extractFile, 'extractHashtags'), extractFile, { unique: array.unique }).extractHashtags;
const constFile = 'packages/backend/src/const.ts';
const noteTextLimit = ts.createSourceFile(constFile, source(constFile), ts.ScriptTarget.Latest, true).statements
	.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText() === 'DB_MAX_NOTE_TEXT_LENGTH'));
assert(noteTextLimit);
const { DB_MAX_NOTE_TEXT_LENGTH } = compile(noteTextLimit.getText(), constFile);
const utilityFile = 'packages/backend/src/core/UtilityService.ts';
const Utility = compile(`export class Utility {${methods(utilityFile, 'UtilityService', ['isKeyWordIncluded'])}}`, utilityFile).Utility;
const Hashtag = compile(`export class Hashtag {${methods(hashtagFile, 'HashtagService', ['updateHashtags', 'updateUsertags', 'updateHashtag', '#incrementHashTag', '#decrementHashTag', 'updateHashtagsRanking'])}}`, hashtagFile, { normalizeForSearch }).Hashtag;
const featuredConstants = ts.createSourceFile(featuredFile, source(featuredFile), ts.ScriptTarget.Latest, true).statements
	.filter(n => ts.isVariableStatement(n)).map(n => n.getText()).join('\n');
const Featured = compile(`${featuredConstants}\nexport class Featured {${methods(featuredFile, 'FeaturedService', ['getCurrentWindow', 'updateRankingOf', 'updateHashtagsRanking'])}}`, featuredFile).Featured;
const manager = declaration(createFile, 'NotificationManager');
const Post = compile(`${manager.node.getText(manager.ast)}\nexport class Post {${methods(createFile, 'NoteCreateService', ['postNoteCreated', 'isRenote', 'isQuote'])}}`, createFile).Post;
// Entire create + insertNote methods run: no copied extraction fragment or replacement normalizer.
const Create = compile(`export class Create { #shutdownController = new AbortController(); ${methods(createFile, 'NoteCreateService', ['create', 'insertNote', 'isRenote', 'isQuote'])}}`, createFile,
	{ normalizeForSearch, extractHashtags, concat: array.concat, DB_MAX_NOTE_TEXT_LENGTH, extractCustomEmojisFromMfm: () => [] }).Create;
const Delete = compile(`export class Delete {${methods(deleteFile, 'NoteDeleteService', ['delete'])}}`, deleteFile).Delete;
const baseAuthor = { id: 'author', username: 'author', host: null, isBot: false, isCat: false };
const baseNote = { id: 'note', userId: 'author', userHost: null, visibility: 'public', localOnly: true, channelId: null, replyId: null };
const columnDefaults = Object.fromEntries(['mentioned', 'attached'].flatMap(prefix => ['', 'Local', 'Remote'].flatMap(scope => [
	[`${prefix}${scope}UserIds`, []], [`${prefix}${scope}UsersCount`, 0],
])));
function setup(mode = 'ok', meta = {}) {
	const calls = [];
	const held = deferred();
	const record = (method, body = {}) => calls.push({ method, ...clone(body) });
	const rows = new Map();
	const scores = new Map();
	const sets = new Map();
	const hll = new Map();
	const ttl = new Map();
	const keyExists = key => scores.has(key) || sets.has(key) || hll.has(key);
	function expireOld() {
		for (const [key, expiry] of ttl) if (now >= expiry.expiresAtMs) { scores.delete(key); sets.delete(key); hll.delete(key); ttl.delete(key); }
	}
	function apply(commands) {
		expireOld();
		for (const [method, key, arg, extra] of commands) {
			if (method === 'zincrby') { if (!scores.has(key)) scores.set(key, new Map()); scores.get(key).set(extra, (scores.get(key).get(extra) || 0) + arg); }
			if (method === 'sadd' || method === 'pfadd') { const store = method === 'sadd' ? sets : hll; if (!store.has(key)) store.set(key, new Set()); store.get(key).add(arg); }
			if (method === 'expire' && keyExists(key) && !ttl.has(key)) ttl.set(key, { seconds: arg, setAtMs: now, expiresAtMs: now + arg * 1000 });
		}
	}
	function commands(kind) {
		record(kind);
		const queue = [];
		return Object.fromEntries(['zincrby', 'expire', 'pfadd', 'sadd'].map(method => [method, (...args) => { record(method, { args }); queue.push([method, ...args]); }]).concat([
			['exec', async () => {
				record(`${kind}-exec`);
				if (mode === `hold-${kind}`) await held.promise;
				if (mode === `reject-${kind}`) throw new Error(`${kind} failed`);
				if (mode === `command-error-${kind}`) return queue.map(() => [new Error('command failed'), null]);
				apply(queue); return queue.map(() => [null, 1]);
			}],
		]));
	}
	const redisClient = {
		async sismember(key, member) {
			expireOld(); const result = sets.get(key)?.has(member) ? 1 : 0;
			record('sismember', { key, member, result });
			if (mode === 'hold-sismember' || mode === 'race-sismember') await held.promise;
			if (mode === 'reject-sismember') throw new Error('sismember failed');
			return result;
		},
		multi: () => commands('multi'), pipeline: () => commands('pipeline'),
	};
	const db = { createQueryRunner(role) {
		record('runner', { role });
		return {
			async query(sql, params) {
				record('query', { sql, params });
				if (mode === 'hold-query') await held.promise;
				if (mode === 'reject-query' || mode === 'reject-query-and-release') throw new Error('query failed');
				const [name, userId] = params;
				// This intentionally models only the generated membership SQL. Real PG is a separate test.
				const increment = sql.startsWith('INSERT');
				if (!rows.has(name) && !increment) return [];
				if (!rows.has(name)) rows.set(name, { name, ...clone(columnDefaults) });
				const row = rows.get(name);
				const matched = [...sql.matchAll(/"((?:mentioned|attached)(?:Local|Remote)?UserIds)"\s*=/g)].map(m => m[1]);
				assert.equal(matched.length, 2, 'both total and local/remote arrays must be updated');
				for (const idsColumn of matched) {
					const countColumn = idsColumn.replace('UserIds', 'UsersCount');
					const exists = row[idsColumn].includes(userId);
					if (increment && !exists) { row[idsColumn].push(userId); row[countColumn]++; }
					if (!increment && exists) { row[idsColumn] = row[idsColumn].filter(id => id !== userId); row[countColumn]--; }
				}
				return [];
			},
			async release() { record('release'); if (mode === 'reject-release' || mode === 'reject-query-and-release') throw new Error('release failed'); },
		};
	} };
	const featuredService = Object.assign(new Featured(), { redisClient });
	const utilityService = Object.assign(new Utility(), { isMediaSilencedHost: () => false, isSilencedHost: () => false });
	let ids = 0;
	const idService = { gen: () => `generated-${++ids}` };
	const hashtagService = Object.assign(new Hashtag(), { db, meta: { hiddenTags: [], sensitiveWords: [], ...meta }, redisClient,
		userEntityService: { isLocalUser: user => user.host == null }, featuredService, idService, utilityService });
	const post = Object.assign(new Post(), {
		notesChart: { update() {} }, perUserNotesChart: { update() {} }, meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false },
		hashtagService, incNotesCountOfUser() {}, pushToTl() {}, antennaService: { addNoteToAntennas() {} }, saveReply() {},
		notesRepository: { countBy: async () => 2 },
		followingsRepository: { findBy: async () => [] }, queueService: { endedPollNotificationQueue: { add() {} } },
		userEntityService: { isLocalUser: user => user.host == null, isRemoteUser: user => user.host != null }, activeUsersChart: { write() {} },
		noteEntityService: { pack: async note => { record('pack'); if (mode === 'reject-pack') throw new Error('pack failed'); return note; } },
		globalEventService: { publishNotesStream() {}, publishMainStream() {} }, roleService: { addNoteToRoleTimeline() {} }, webhookService: { enqueueUserWebhook() {} },
		notificationService: { createNotification: async () => {} }, createMentionedEvents: async () => {},
		channelsRepository: { increment: async () => {}, update: async () => {} }, index: () => record('index'),
		renderNoteOrRenoteActivity: async () => ({}), apDeliverManagerService: { createDeliverManager: () => ({ addFollowersRecipe() {}, execute: async () => {} }) }, relayService: { deliverToRelays() {} },
	});
	return { calls, held, record, rows, redisClient, hashtagService, featuredService, utilityService, post, idService,
		state() {
			expireOld();
			return { dbRows: Object.fromEntries(rows), scores: Object.fromEntries([...scores].map(([key, members]) => [key, Object.fromEntries(members)])),
				sets: Object.fromEntries([...sets].map(([key, members]) => [key, [...members]])),
				hllMembers: Object.fromEntries([...hll].map(([key, members]) => [key, [...members]])), ttl: Object.fromEntries(ttl) };
		},
	};
}
const observations = [];
async function capture(id, kind, run) {
	const unhandled = [];
	const listener = e => unhandled.push(e?.message || String(e));
	process.on('unhandledRejection', listener);
	try {
		const value = await run(); await tick(); await tick();
		observations.push({ id, kind, ...value, unhandledRejectionsCapturedByHarness: unhandled });
	} finally { process.off('unhandledRejection', listener); now = NOW; process.env.TZ = 'UTC'; }
}
async function updateCase(input) {
	now = input.nowMs ?? NOW;
	process.env.TZ = input.timezone ?? 'UTC';
	const f = setup(input.mode, input.meta);
	const user = { ...baseAuthor, ...input.user };
	let error;
	try { await f.hashtagService.updateHashtags(user, input.tags); } catch (e) { error = e.message; }
	await tick(); await tick();
	return { input: { ...input, nowMs: now, user }, calls: f.calls, state: f.state(), ...(error ? { error } : {}) };
}
for (const [id, input] of [
	['local-first', { tags: ['MiSsKeY'] }], ['remote-first', { tags: ['MiSsKeY'], user: { host: 'remote.example' } }],
	['normalize-collision', { tags: ['Ａ', 'a', 'A'] }], ['empty-tag-direct-service', { tags: [''] }],
	['normalizer-no-trim', { tags: [' A '] }], ['hidden-exact-normalized', { tags: ['Tag'], meta: { hiddenTags: ['ＴＡＧ'] } }],
	['hidden-substring-kept', { tags: ['tagging'], meta: { hiddenTags: ['tag'] } }],
	['sensitive-substring', { tags: ['abc'], meta: { sensitiveWords: ['b'] } }],
	['sensitive-AND', { tags: ['abc'], meta: { sensitiveWords: ['a c'] } }],
	['sensitive-case-preserved', { tags: ['ABC'], meta: { sensitiveWords: ['A'] } }],
	['sensitive-regex', { tags: ['AbC'], meta: { sensitiveWords: ['/B/i'] } }],
	['sensitive-invalid-regex', { tags: ['abc'], meta: { sensitiveWords: ['/[a/'] } }],
	['sensitive-empty-text', { tags: [''], meta: { sensitiveWords: [''] } }],
]) await capture(`update-${id}`, 'update', () => updateCase(input));
for (const mode of ['reject-query', 'reject-release', 'reject-query-and-release', 'reject-sismember', 'reject-multi', 'reject-pipeline', 'command-error-multi', 'command-error-pipeline']) {
	await capture(`failure-${mode}`, 'failure', () => updateCase({ tags: ['first', 'second'], mode }));
}
for (const edge of ['2026-11-07T12:40:00Z', '2026-11-07T13:00:00Z', '2026-11-08T00:00:00Z', '2023-01-01T00:00:00Z']) {
	for (const offset of [-1, 0, 1]) await capture(`window-${edge}-${offset}`, 'update', () => updateCase({ tags: ['tag'], nowMs: Date.parse(edge) + offset }));
}
for (const timezone of ['Asia/Tokyo', 'Asia/Kathmandu', 'America/New_York']) {
	await capture(`timezone-${timezone}`, 'update', () => updateCase({ tags: ['tag'], timezone }));
}
for (const [id, actions] of [
	['same-user-repeat', [{ at: 0, id: 'u1' }, { at: 1000, id: 'u1' }]],
	['new-user-nx', [{ at: 0, id: 'u1' }, { at: 1000, id: 'u2' }]],
	['next-chart-suppressed', [{ at: 0, id: 'u1' }, { at: 600000, id: 'u1' }]],
	['shared-set-expires', [{ at: 0, id: 'u1' }, { at: 3599999, id: 'u2' }, { at: 3600000, id: 'u2' }]],
	['hour-boundary-still-suppressed', [{ at: 0, id: 'u1' }, { at: 600000, id: 'u1' }]],
]) await capture(`sequence-${id}`, 'sequence', async () => {
	const start = id === 'hour-boundary-still-suppressed' ? Date.parse('2026-11-07T12:55:00Z') : NOW;
	const f = setup();
	for (const action of actions) { now = start + action.at; await f.hashtagService.updateHashtags({ id: action.id, host: null }, ['tag']); await tick(); }
	const state = f.state();
	if (id === 'same-user-repeat') assert.equal(Object.values(state.scores)[0].tag, 1);
	if (id === 'new-user-nx') assert.equal(state.ttl['hashtagUsers:tag'].setAtMs, start);
	return { input: { nowMs: start, actions }, calls: f.calls, state };
});
for (const [id, input] of [
	...['public', 'home', 'followers', 'specified'].map(visibility => [visibility, { visibility }]),
	['silent', { silent: true }], ['remote', { user: { host: 'remote.example' } }], ['bot', { user: { isBot: true } }],
	['localOnly', { note: { localOnly: true } }], ['sensitive-channel', { note: { channelId: 'channel' }, data: { channel: { id: 'channel', isSensitive: true } } }],
	['reply', { data: { reply: { id: 'reply', userId: 'other' } } }], ['empty-tags', { tags: [] }],
	['pack-fails-after-start', { mode: 'reject-pack' }],
	['gate-data-public-note-followers', { visibility: 'public', note: { visibility: 'followers' } }],
	['gate-data-followers-note-public', { visibility: 'followers', note: { visibility: 'public' } }],
]) await capture(`post-${id}`, 'post', async () => {
	const f = setup(input.mode); const user = { ...baseAuthor, ...input.user };
	const note = { ...baseNote, visibility: input.visibility ?? 'public', ...input.note };
	const data = { visibility: input.visibility ?? 'public', localOnly: true, ...input.data };
	let error; try { await f.post.postNoteCreated(note, user, data, input.silent ?? false, input.tags ?? ['Tag'], []); } catch (e) { error = e.message; }
	await tick(); await tick();
	return { input: { nowMs: now, user, note, data, silent: input.silent ?? false, tags: input.tags ?? ['Tag'], mode: input.mode ?? 'ok' }, calls: f.calls, state: f.state(), ...(error ? { error } : {}) };
});
for (const [id, data] of [
	['text-cw-poll-order', { text: '#Text #Same', cw: '#CW #Same', poll: { choices: ['#Poll #Same', '#Last'], multiple: false, expiresAt: null } }],
	['normalized-duplicates', { text: '#Ａ #a #A' }], ['nested-mfm', { text: '**#Bold** $[x2 #Large] `#Code`' }],
	['explicit-ap-empty', { text: '#Ignored', apHashtags: [] }], ['explicit-ap-raw', { text: '#Ignored', apHashtags: ['Ａ', 'a', 'Ａ'] }],
	['codepoint-limit', { apHashtags: ['😀'.repeat(128), '😀'.repeat(129), 'a'.repeat(128), 'a'.repeat(129)] }],
	['filter-before-limit', { apHashtags: ['x'.repeat(129), ...Array.from({ length: 33 }, (_, index) => `t${index}`)] }],
	['normalize-after-length-filter', { apHashtags: ['㍿'.repeat(128)] }], ['text-trim', { text: '  #Tag  ' }],
	['raw-empty-ap-tag', { apHashtags: [''] }], ['cw-only', { cw: '#Warning' }],
	['text-truncated-before-extract', { text: 'x'.repeat(8192) + ' #Excluded', cw: '#CW' }],
]) await capture(`create-${id}`, 'create', async () => {
	const f = setup();
	const creator = Object.assign(new Create(), {
		meta: { sensitiveWords: [], prohibitedWords: [], silencedHosts: [], mediaSilencedHosts: [] }, utilityService: f.utilityService,
		roleService: { getUserPolicies: async () => ({ canPublicNote: true, mentionLimit: 20 }) }, checkProhibitedWordsContain: () => false,
		idService: f.idService, userEntityService: { isRemoteUser: user => user.host != null },
		notesRepository: { insert: async note => f.record('note-insert', { note }) },
		db: { transaction: async callback => callback({ insert: async (entity, row) => f.record('transaction-insert', { entity: entity.name, row }) }) },
		extractMentionedUsers: async () => [],
		postNoteCreated: async (_note, _user, _data, _silent, tags) => f.record('post-raw-tags', { tags }),
	});
	const options = { visibility: 'public', localOnly: false, apEmojis: [], apMentions: [], ...clone(data) };
	const note = await creator.create(baseAuthor, options, true); await tick();
	if (id === 'normalized-duplicates') assert.deepEqual([...note.tags], ['a', 'a', 'a']);
	if (id === 'explicit-ap-empty') assert.equal(note.tags.length, 0);
	if (id === 'filter-before-limit') assert.equal(note.tags.length, 32);
	if (id === 'normalize-after-length-filter') assert.equal(note.tags[0].length, 512);
	return { input: { nowMs: now, user: baseAuthor, data }, calls: f.calls, savedTags: clone(note.tags), rawPostTags: f.calls.find(call => call.method === 'post-raw-tags').tags };
});
for (const [id, initial, user, tags] of [
	['local-add', null, { id: 'u1', host: null, tags: [] }, ['Tag']],
	['remote-add', null, { id: 'u1', host: 'remote.example', tags: [] }, ['Tag']],
	['remove-still-ranks', { name: 'old', attachedUserIds: ['u1'], attachedUsersCount: 1, attachedLocalUserIds: ['u1'], attachedLocalUsersCount: 1 }, { id: 'u1', host: null, tags: ['old'] }, []],
	['remove-missing-no-row', null, { id: 'u1', host: null, tags: ['missing'] }, []],
	['old-normalized-new-collision', { name: 'a', attachedUserIds: ['u1'], attachedUsersCount: 1, attachedLocalUserIds: ['u1'], attachedLocalUsersCount: 1 }, { id: 'u1', host: null, tags: ['a'] }, ['Ａ']],
]) await capture(`profile-boundary-${id}`, 'profile', async () => {
	const f = setup(); if (initial) f.rows.set(initial.name, { ...clone(columnDefaults), ...clone(initial) });
	await f.hashtagService.updateUsertags(user, tags); await tick(); await tick();
	return { input: { nowMs: now, initial, user, tags }, calls: f.calls, state: f.state() };
});
await capture('sql-independent-membership-and-preserved-attached', 'update', async () => {
	const f = setup();
	const initial = { name: 'tag', ...clone(columnDefaults), mentionedUserIds: ['u1'], mentionedUsersCount: 77, attachedUserIds: ['attached'], attachedUsersCount: 5 };
	f.rows.set('tag', clone(initial));
	await f.hashtagService.updateHashtags({ id: 'u1', host: null }, ['tag']); await tick();
	assert.equal(f.state().dbRows.tag.mentionedUsersCount, 77);
	assert.equal(f.state().dbRows.tag.mentionedLocalUsersCount, 1);
	assert.equal(f.state().dbRows.tag.attachedUsersCount, 5);
	return { input: { nowMs: now, initial, user: { id: 'u1', host: null }, tags: ['tag'] }, calls: f.calls, state: f.state() };
});
await capture('sql-local-and-remote-distinct-users', 'sequence', async () => {
	const f = setup(); const users = [{ id: 'local', host: null }, { id: 'remote', host: 'remote.example' }, { id: 'remote', host: 'remote.example' }];
	for (const user of users) { await f.hashtagService.updateHashtags(user, ['tag']); await tick(); }
	assert.equal(f.state().dbRows.tag.mentionedUsersCount, 2);
	return { input: { nowMs: now, users }, calls: f.calls, state: f.state() };
});
// Measure settlement while a dependency is still held. An awaited negative control
// proves the same gate can distinguish pending from settled; every gate releases in finally.
for (const [id, mode, entry, expected] of [
	['update-before-sismember', 'hold-sismember', 'update', true],
	['update-before-featured-exec', 'hold-multi', 'update', true],
	['update-before-chart-exec', 'hold-pipeline', 'update', true],
	['post-before-query', 'hold-query', 'post', true],
	['negative-control-update-awaits-query', 'hold-query', 'update', false],
	['negative-control-featured-awaits-exec', 'hold-multi', 'featured', false],
]) await capture(`lifetime-${id}`, 'lifetime', async () => {
	const f = setup(mode); let settled = false;
	const promise = (entry === 'post' ? f.post.postNoteCreated(baseNote, baseAuthor, { visibility: 'public', localOnly: true }, true, ['tag'], [])
		: entry === 'featured' ? f.featuredService.updateHashtagsRanking('tag', 1) : f.hashtagService.updateHashtags(baseAuthor, ['tag']))
		.then(() => { settled = true; f.record('entry-settled'); });
	let settledBeforeRelease; let stateBeforeRelease;
	try { await tick(); await tick(); settledBeforeRelease = settled; stateBeforeRelease = f.state(); assert.equal(settledBeforeRelease, expected); }
	finally { f.record('gate-released'); f.held.resolve(); await promise; await tick(); await tick(); }
	return { input: { nowMs: NOW, mode, entry }, settledBeforeRelease, stateBeforeRelease, calls: f.calls, state: f.state() };
});
await capture('race-concurrent-same-user-admits-twice', 'race', async () => {
	const f = setup('race-sismember');
	const promises = [f.hashtagService.updateHashtags(baseAuthor, ['tag']), f.hashtagService.updateHashtags(baseAuthor, ['tag'])];
	try { await tick(); assert.equal(f.calls.filter(call => call.method === 'sismember' && call.result === 0).length, 2); }
	finally { f.record('gate-released'); f.held.resolve(); await Promise.all(promises); await tick(); await tick(); }
	const state = f.state(); assert.equal(Object.values(state.scores)[0].tag, 2); assert.equal(state.dbRows.tag.mentionedUsersCount, 1);
	assert.equal(Object.values(state.hllMembers)[0].length, 1);
	return { input: { nowMs: now, user: baseAuthor, tags: ['tag'], concurrentCalls: 2 }, calls: f.calls, state };
});
await capture('window-sismember-delay-chart-old-featured-new', 'race', async () => {
	const f = setup('hold-sismember'); const before = Date.parse('2026-11-07T12:59:59.999Z'); const after = before + 1;
	now = before;
	const promise = f.hashtagService.updateHashtags(baseAuthor, ['tag']);
	try { await tick(); now = after; }
	finally { f.held.resolve(); await promise; await tick(); await tick(); }
	const state = f.state();
	assert(Object.hasOwn(state.hllMembers, 'hashtagUsers:tag:202611071250'));
	assert(Object.hasOwn(state.scores, `featuredHashtagsRanking:${Math.floor((after - EPOCH) / 3600000)}`));
	return { input: { beforeMs: before, afterMs: after }, calls: f.calls, state };
});
await capture('cache-meta-read-on-each-ranking-call', 'sequence', async () => {
	const f = setup();
	await f.hashtagService.updateHashtags({ id: 'before', host: null }, ['tag']); await tick();
	f.hashtagService.meta.hiddenTags = ['ＴＡＧ'];
	await f.hashtagService.updateHashtags({ id: 'after', host: null }, ['tag']); await tick();
	assert.equal(f.state().dbRows.tag.mentionedUsersCount, 2); assert.equal(Object.values(f.state().scores)[0].tag, 1);
	return { input: { nowMs: now, initialHiddenTags: [], nextHiddenTags: ['ＴＡＧ'] }, calls: f.calls, state: f.state() };
});
for (const quiet of [false, true]) for (const dbFails of [false, true]) await capture(`delete-no-cleanup-quiet${quiet}-dbFails${dbFails}`, 'delete', async () => {
	const f = setup(); await f.hashtagService.updateHashtags(baseAuthor, ['tag']); await tick(); const before = f.state();
	f.record('delete-started');
	const del = Object.assign(new Delete(), { hashtagService: f.hashtagService, featuredService: f.featuredService,
		notesRepository: { delete: async () => { f.record('db-delete'); if (dbFails) throw new Error('db delete failed'); } },
		searchService: { unindexNote: () => f.record('search-unindex') }, globalEventService: { publishNoteStream: () => f.record('deleted-publication') },
		notesChart: { update() {} }, perUserNotesChart: { update() {} }, meta: { enableStatsForFederatedInstances: false }, userEntityService: { isLocalUser: () => true },
	});
	let error; try { await del.delete(baseAuthor, baseNote, quiet); } catch (e) { error = e.message; }
	assert.deepEqual(f.state(), before);
	assert(!f.calls.slice(f.calls.findIndex(call => call.method === 'delete-started') + 1).some(call => ['runner', 'multi', 'pipeline', 'sismember'].includes(call.method)));
	return { input: { quiet, dbFails }, stateBeforeDelete: before, calls: f.calls, state: f.state(), ...(error ? { error } : {}) };
});
const result = { fixedCommit: sha, clockTimezone: 'UTC except observations with input.timezone',
	evidence: 'Actual pinned HashtagService update methods including private increment/decrement; FeaturedService hashtag update/window; entire NoteCreateService.create/insertNote/postNoteCreated and NotificationManager; UtilityService.isKeyWordIncluded; extractHashtags/normalizeForSearch; NoteDeleteService.delete. Redis/SQL state, repositories, IDs, clock and unrelated collaborators doubled. Not a full-server/real-PG/real-Redis comparison.',
	dependencies: Object.fromEntries(['mfm-js', 're2'].map(name => [name, JSON.parse(fs.readFileSync(path.join(repository, 'packages/backend-next/node_modules', name, 'package.json'), 'utf8')).version])),
	sources: [...sources].map(([file, value]) => ({ path: file, blob: value.blob })), observations };
fs.writeFileSync(path.join(output, 'source-observations.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${observations.length} pinned upstream hashtag observations saved to ${output}\n`);
