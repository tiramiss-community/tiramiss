/* SPDX-FileCopyrightText: 2026 tiramiss-community */
/* SPDX-License-Identifier: AGPL-3.0-only */
// Execute pinned upstream method bodies; repositories/Redis/time/random are doubles.
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
const ts = createRequire(path.join(repository, 'package.json'))('typescript');
const output = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(tmpdir(), 'featured-reference-'));
fs.mkdirSync(output, { recursive: true });
const sources = new Map();
const DAY = 86400000;
const EPOCH = Date.parse('2023-01-01T00:00:00Z');
const NOW = Date.parse('2026-11-07T12:34:56Z');
let now = NOW;
let random = 0.1;
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
	const node = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name);
	assert(node, name);
	return { ast, node };
}
function methods(file, name, names) {
	const { ast, node } = declaration(file, name);
	const selected = node.members.filter(n => names.includes(n.name?.getText(ast)));
	assert.equal(selected.length, names.length);
	return selected.map(n => n.getText(ast)).join('\n');
}
function compile(text, filename) {
	const module = { exports: {} };
	const math = Object.create(Math);
	math.random = () => random;
	vm.runInNewContext(ts.transpileModule(text, { compilerOptions: {
		target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
	} }).outputText, { module, exports: module.exports, Date: Clock, Math: math, Promise, Set, Map,
		bindThis: () => {}, trackPromise: () => {}, isRenote: () => false, isQuote: () => false }, { filename });
	return module.exports;
}
const createFile = 'packages/backend/src/core/NoteCreateService.ts';
const featuredFile = 'packages/backend/src/core/FeaturedService.ts';
const deleteFile = 'packages/backend/src/core/NoteDeleteService.ts';
const manager = declaration(createFile, 'NotificationManager');
const Post = compile(`${manager.node.getText(manager.ast)}\nexport class Post {${methods(createFile, 'NoteCreateService', ['postNoteCreated', 'incRenoteCount', 'isRenote', 'isQuote'])}}`, createFile).Post;
const constants = ts.createSourceFile(featuredFile, source(featuredFile), ts.ScriptTarget.Latest, true).statements
	.filter(n => ts.isVariableStatement(n)).map(n => n.getText()).join('\n');
const Featured = compile(`${constants}\nexport class Featured {${methods(featuredFile, 'FeaturedService', ['getCurrentWindow', 'updateRankingOf', 'updateGlobalNotesRanking', 'updateInChannelNotesRanking', 'updatePerUserNotesRanking'])}}`, featuredFile).Featured;
const Delete = compile(`export class Delete {${methods(deleteFile, 'NoteDeleteService', ['delete'])}}`, deleteFile).Delete;
const baseTarget = { id: String(NOW - DAY), userId: 'target-author', userHost: null, visibility: 'public', channelId: null, replyId: null };
const baseAuthor = { id: 'author', host: null, isBot: false };
const baseNote = { id: String(NOW), userId: 'author', userHost: null, visibility: 'public', localOnly: true, channelId: null };
function setup(mode = 'ok') {
	const calls = [];
	const record = (method, body = {}) => calls.push({ method, ...clone(body) });
	const held = deferred();
	const rankings = new Map();
	const ttl = new Map();
	const redisClient = { multi() {
		record('multi');
		const commands = [];
		return {
			zincrby(key, score, member) { record('zincrby', { key, score, member }); commands.push(['zincrby', key, score, member]); },
			expire(key, seconds, condition) { record('expire', { key, seconds, condition }); commands.push(['expire', key, seconds, condition]); },
			async exec() {
				record('exec');
				if (mode === 'hold-rank') await held.promise;
				if (mode === 'reject-rank') throw new Error('rank failed');
				if (mode === 'command-error') return commands.map(() => [new Error('command failed'), null]);
				for (const [kind, key, value, member] of commands) {
					if (kind === 'zincrby') rankings.set(`${key}/${member}`, (rankings.get(`${key}/${member}`) || 0) + value);
					if (kind === 'expire' && !ttl.has(key)) ttl.set(key, { seconds: value, setAtMs: now });
				}
				return commands.map(() => [null, 1]);
			},
		};
	} };
	const featuredService = Object.assign(new Featured(), { redisClient });
	if (mode === 'throw-first-rank') featuredService.updateGlobalNotesRanking = () => { record('global-threw'); throw new Error('global threw'); };
	const qb = { update: () => qb, set: () => qb, where: (_where, values) => { record('count-target', values); return qb; }, execute: () => {
		record('count-execute'); return mode === 'reject-count' ? Promise.reject(new Error('count failed')) : Promise.resolve();
	} };
	const post = Object.assign(new Post(), { featuredService, idService: { parse: id => ({ date: new Date(Number(id)) }) }, notesRepository: { createQueryBuilder: () => qb, countBy: async () => 2 },
		notesChart: { update() {} }, perUserNotesChart: { update() {} }, meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false },
		hashtagService: { updateHashtags() {} }, incNotesCountOfUser() {}, pushToTl() {}, antennaService: { addNoteToAntennas() {} }, saveReply() {},
		followingsRepository: { findBy: async () => [] }, queueService: { endedPollNotificationQueue: { add() {} } },
		userEntityService: { isLocalUser: u => u.host == null, isRemoteUser: u => u.host != null }, activeUsersChart: { write() {} },
		noteEntityService: { pack: async n => { record('pack'); if (mode === 'reject-pack') throw new Error('pack failed'); return n; } },
		globalEventService: { publishNotesStream() {}, publishMainStream() {} }, roleService: { addNoteToRoleTimeline() {} }, webhookService: { enqueueUserWebhook() {} },
		notificationService: { createNotification: async () => {} },
		createMentionedEvents: async () => {}, channelsRepository: { increment: async () => {}, update: async () => {} }, index: () => record('index'),
		renderNoteOrRenoteActivity: async () => ({}), apDeliverManagerService: { createDeliverManager: () => ({ addFollowersRecipe() {}, execute: async () => {} }) }, relayService: { deliverToRelays() {} },
	});
	return { calls, post, featuredService, held, record, state: () => ({ scores: Object.fromEntries(rankings), ttl: Object.fromEntries(ttl) }) };
}
const observations = [];
async function capture(id, run) {
	const unhandled = [];
	const listener = e => unhandled.push(e?.message || String(e));
	process.on('unhandledRejection', listener);
	try {
		const value = await run(); await tick(); await tick();
		observations.push({ id, ...value, unhandledRejectionsCapturedByHarness: unhandled });
	} finally { process.off('unhandledRejection', listener); now = NOW; random = 0.1; }
}
async function postCase(input) {
	const f = setup(input.mode);
	const author = { ...baseAuthor, ...input.author };
	const target = input.noRenote ? null : { ...baseTarget, ...input.target };
	const note = { ...baseNote, ...input.note };
	const data = { visibility: note.visibility, localOnly: true, renote: target, ...input.data };
	let error;
	try { await f.post.postNoteCreated(note, author, data, input.silent || false, [], []); } catch (e) { error = e.message; }
	await tick();
	return { input: { nowMs: now, random, author, target, note, data, silent: input.silent || false, mode: input.mode || 'ok' }, calls: f.calls, state: f.state(), ...(error ? { error } : {}) };
}
for (const [id, input] of [
	['ordinary-note', { noRenote: true }], ['pure-renote', {}], ['quote-text', { data: { text: 'quote' } }], ['quote-poll', { data: { poll: { choices: ['a', 'b'] } } }],
	['self-renote', { author: { id: 'target-author' } }], ['bot-renote', { author: { isBot: true } }], ['remote-actor', { author: { host: 'remote.example' } }],
	['silent-renote', { silent: true }], ['actor-home', { note: { visibility: 'home' } }], ['actor-followers', { note: { visibility: 'followers' } }],
	['actor-specified', { note: { visibility: 'specified' } }], ['target-home', { target: { visibility: 'home' } }], ['target-followers', { target: { visibility: 'followers' } }],
	['target-specified', { target: { visibility: 'specified' } }], ['target-remote', { target: { userHost: 'remote.example' } }], ['target-reply', { target: { replyId: 'reply' } }],
	['target-channel', { target: { channelId: 'channel' } }], ['target-channel-remote-private', { target: { channelId: 'channel', userHost: 'remote.example', visibility: 'specified' } }],
	['target-channel-reply', { target: { channelId: 'channel', replyId: 'reply' } }], ['target-localOnly', { target: { localOnly: true } }],
	['target-sensitive-channel', { target: { channelId: 'channel', channel: { isSensitive: true } } }], ['pack-fails-after-featured-start', { mode: 'reject-pack' }],
]) await capture(`post-${id}`, async () => postCase(input));

for (const roll of [0.299999, 0.3, 0.300001]) for (const ageMs of [-1, 3 * DAY - 1, 3 * DAY, 3 * DAY + 1]) {
	await capture(`sampling-${roll}-age${ageMs}`, async () => {
		random = roll;
		const result = await postCase({ target: { id: String(NOW - ageMs) } });
		assert.equal(result.calls.filter(c => c.method === 'zincrby').length, roll < 0.3 && ageMs < 3 * DAY ? 2 : 0);
		return result;
	});
}
for (const rangeDays of [3, 7]) for (const offsetMs of [-1, 0, 1]) {
	await capture(`ranking-window-${rangeDays}days-offset${offsetMs}`, async () => {
		now = EPOCH + 100 * rangeDays * DAY + offsetMs;
		const f = setup();
		if (rangeDays === 3) await f.featuredService.updateGlobalNotesRanking('note', 5);
		else await f.featuredService.updatePerUserNotesRanking('user', 'note', 5);
		const command = f.calls.find(c => c.method === 'zincrby');
		assert(command.key.endsWith(`:${offsetMs < 0 ? 99 : 100}`));
		assert.equal(f.calls.find(c => c.method === 'expire').seconds, rangeDays * DAY * 3 / 1000);
		return { input: { nowMs: now, rangeDays, offsetMs }, calls: f.calls, state: f.state() };
	});
}
await capture('ranking-repeat-increments-and-keeps-initial-expiry', async () => {
	const f = setup(); await f.featuredService.updateGlobalNotesRanking('note', 5);
	now += 1000; await f.featuredService.updateGlobalNotesRanking('note', 5);
	assert.equal(Object.values(f.state().scores)[0], 10);
	assert.equal(Object.values(f.state().ttl)[0].setAtMs, NOW);
	return { input: { firstAtMs: NOW, secondAtMs: now }, calls: f.calls, state: f.state() };
});
for (const mode of ['reject-count', 'reject-rank', 'command-error', 'throw-first-rank']) {
	await capture(`failure-${mode}`, async () => postCase({ mode }));
}
await capture('lifetime-post-returns-before-ranking-exec', async () => {
	const f = setup('hold-rank');
	await f.post.postNoteCreated(baseNote, baseAuthor, { visibility: 'public', localOnly: true, renote: baseTarget }, true, [], []);
	const returnedBeforeRelease = true;
	assert.equal(Object.keys(f.state().scores).length, 0);
	f.record('post-returned'); f.held.resolve(); await tick();
	assert.equal(Object.keys(f.state().scores).length, 2);
	return { input: { nowMs: now, random, target: baseTarget }, returnedBeforeRelease, calls: f.calls, state: f.state() };
});
for (const quiet of [false, true]) for (const dbFails of [false, true]) {
	await capture(`delete-no-cleanup-quiet${quiet}-dbFails${dbFails}`, async () => {
		const f = setup();
		const del = Object.assign(new Delete(), { featuredService: f.featuredService,
			notesRepository: { delete: async () => { f.record('db-delete'); if (dbFails) throw new Error('db delete failed'); } },
			searchService: { unindexNote: () => f.record('search-unindex') }, globalEventService: { publishNoteStream: () => f.record('deleted-publication') },
			notesChart: { update() {} }, perUserNotesChart: { update() {} }, meta: { enableStatsForFederatedInstances: false }, userEntityService: { isLocalUser: () => true },
		});
		let error; try { await del.delete(baseAuthor, baseNote, quiet); } catch (e) { error = e.message; }
		assert(!f.calls.some(c => c.method === 'multi'));
		return { input: { quiet, dbFails }, calls: f.calls, ...(error ? { error } : {}) };
	});
}
const result = { fixedCommit: sha, evidence: 'Actual pinned NoteCreateService.postNoteCreated/incRenoteCount/isRenote/isQuote, NotificationManager, FeaturedService update methods, NoteDeleteService.delete; repositories, Redis, clocks, random and unrelated collaborators doubled. Not full server/real DB/Redis.',
	sources: Object.fromEntries([...sources].map(([file, { blob }]) => [file, { blob }])), observations };
fs.writeFileSync(path.join(output, 'source-observations.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cases: observations.length, sources: result.sources, output: path.join(output, 'source-observations.json') }));
