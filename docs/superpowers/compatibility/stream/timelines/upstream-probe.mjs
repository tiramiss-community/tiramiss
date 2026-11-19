/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const repository = process.env.UPSTREAM_ROOT;
if (!repository) {
	throw new Error('Set UPSTREAM_ROOT to a checkout containing the pinned Git objects');
}
const sha = '8e07cf085adf7009583d234a208e30436f020e26';
const sourceRoot = 'packages/backend/src/';
const requireRoot = createRequire(path.join(process.env.REPOSITORY_ROOT ?? process.cwd(), 'package.json'));
const ts = requireRoot('typescript');
const observed = [];
const blobs = new Map();
const modules = new Map();
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');

class FixedDate extends Date {
	constructor(...args) {
		super(...(args.length ? args : [fixedNow]));
	}

	static now() {
		return fixedNow;
	}
}

class EmptyService {}

function source(relative) {
	const full = sourceRoot + relative;
	if (!blobs.has(full)) {
		const text = execFileSync('git', ['-C', repository, 'show', `${sha}:${full}`], { encoding: 'utf8' });
		const blob = execFileSync('git', ['-C', repository, 'rev-parse', `${sha}:${full}`], { encoding: 'utf8' }).trim();
		blobs.set(full, { text, blob });
	}
	return blobs.get(full).text;
}

const actualFiles = new Set([
	'decorators.ts',
	'misc/normalize-for-search.ts',
	'misc/is-renote.ts',
	'misc/is-instance-muted.ts',
	'misc/is-user-related.ts',
	'misc/is-channel-related.ts',
	'misc/clone.ts',
	'misc/should-hide-note-by-time.ts',
	'server/api/stream/channel.ts',
	'server/api/stream/NoteStreamingHidingService.ts',
	'server/api/stream/channels/local-timeline.ts',
	'server/api/stream/channels/hybrid-timeline.ts',
	'server/api/stream/channels/global-timeline.ts',
]);

function load(relative, customSource) {
	if (!customSource && modules.has(relative)) {
		return modules.get(relative).exports;
	}
	const module = { exports: {} };
	if (!customSource) {
		modules.set(relative, module);
	}
	const compiled = ts.transpileModule(customSource ?? source(relative), {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			experimentalDecorators: true,
			emitDecoratorMetadata: false,
		},
	}).outputText;
	const localRequire = (specifier) => {
		if (specifier === '@nestjs/common') {
			return { Inject: () => () => {}, Injectable: () => () => {}, Scope: { TRANSIENT: 'transient' } };
		}
		if (specifier === '@nestjs/core') {
			return { ContextIdFactory: { create: () => ({}) }, ModuleRef: EmptyService, REQUEST: Symbol('request') };
		}
		if (specifier === '@/di-symbols.js') {
			return { DI: {} };
		}
		if (specifier === 'xev') {
			return { __esModule: true, default: EventEmitter };
		}
		if (specifier === 'events') {
			return { EventEmitter };
		}
		if (specifier === 'promise-limit') {
			return () => (fn) => Promise.resolve().then(fn);
		}
		if (specifier === '@/misc/json-value.js') {
			return { isJsonObject: (x) => x !== null && typeof x === 'object' && !Array.isArray(x) };
		}
		let resolved = specifier.startsWith('@/')
			? specifier.slice(2)
			: specifier.startsWith('.')
				? path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
				: null;
		resolved = resolved?.replace(/\.js$/, '.ts');
		if (actualFiles.has(resolved)) {
			return load(resolved);
		}
		return new Proxy({}, { get: (_target, key) => (key === '__esModule' ? false : EmptyService) });
	};
	const context = {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		Date: FixedDate,
		Set,
		Map,
		Object,
		Promise,
		JSON,
		Reflect,
		Symbol,
		URL,
		Buffer,
		setInterval: () => ({ fake: true }),
		clearInterval: () => {},
	};
	vm.runInNewContext(compiled, context, { filename: relative });
	return module.exports;
}

// Extract only literal methods from the pinned source, retaining their original bodies.
const entityFile = 'core/entities/NoteEntityService.ts';
const entityAst = ts.createSourceFile(entityFile, source(entityFile), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const entityClass = entityAst.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'NoteEntityService');
const entityMembers = entityClass.members
	.filter((m) => ['shouldHideNote', 'hideNote'].includes(m.name?.getText(entityAst)))
	.map((m) => m.getText(entityAst))
	.join('\n');
const EntityOracle = load(
	'entity-oracle.ts',
	`import {bindThis} from '@/decorators.js';\nimport {shouldHideNoteByTime} from '@/misc/should-hide-note-by-time.js';\nexport class EntityOracle { ${entityMembers} }`,
).EntityOracle;
const Hiding = load('server/api/stream/NoteStreamingHidingService.ts').NoteStreamingHidingService;
const channels = {
 localTimeline: load('server/api/stream/channels/local-timeline.ts').LocalTimelineChannel,
 hybridTimeline: load('server/api/stream/channels/hybrid-timeline.ts').HybridTimelineChannel,
 globalTimeline: load('server/api/stream/channels/global-timeline.ts').GlobalTimelineChannel,
};
const copy = (x) => JSON.parse(JSON.stringify(x));

function facts(overrides = {}) {
	return {
		user: { id: 'viewer', isHibernated: false },
		following: { author: { withReplies: false } },
		followingChannels: [],
		mutingChannels: [],
		mutedInstances: [],
		muting: [],
		blockingMe: [],
		renoteMuting: [],
		ugc: 'all',
		policies: { ltlAvailable: true, gtlAvailable: true },
		...overrides,
	};
}

function note(overrides = {}) {
	return {
		id: 'note',
		userId: 'author',
		user: { id: 'author', host: null, requireSigninToViewContents: false, makeNotesHiddenBefore: null },
		createdAt: '2026-11-06T23:59:00.000Z',
		text: 'text',
		cw: null,
		visibility: 'public',
		channelId: null,
		replyId: null,
		reply: null,
		renoteId: null,
		renote: null,
		poll: null,
		fileIds: [],
		files: [],
		reactions: {},
		...overrides,
	};
}

function connection(data) {
	const sent = [];
	const c = {
		user: data.user,
		userProfile: { mutedInstances: data.mutedInstances },
		following: data.following,
		followingChannels: new Set(data.followingChannels),
		mutingChannels: new Set(data.mutingChannels),
		userIdsWhoMeMuting: new Set(data.muting),
		userIdsWhoBlockingMe: new Set(data.blockingMe),
		userIdsWhoMeMutingRenotes: new Set(data.renoteMuting),
		subscriber: new EventEmitter(),
		sendMessageToWs: (type, body) => sent.push(copy({ type, body })),
	};
	const entity = new EntityOracle();
	entity.meta = { ugcVisibilityForVisitor: data.ugc };
	entity.cacheService = { userFollowingsCache: { fetch: async () => data.hidingFollowing ?? data.following } };
	entity.pack = async (id, viewer, opts) => ({ id, oracleRepacked: true, viewer: viewer.id, detail: opts.detail });
	entity.populateMyReaction = async () => ':own:';
	return { c, sent, entity, hiding: new Hiding(entity.meta, entity) };
}

async function runChannel(name, id, data, n, params = {}) {
 const { c, sent, entity, hiding } = connection(data);
 const role = { getUserPolicies: async () => data.policies };
 const ch = new channels[name]({ id: 'channel-id', connection: c }, entity.meta, role, entity, hiding);
 await ch.init(params);
 const listeners = c.subscriber.listenerCount('notesStream');
 if (listeners) await ch.onNote(copy(n));
 ch.dispose();
 observed.push({ id: `${name}/${id}`, input: { channel: name, facts: data, params, payload: n }, listeners, disposedListeners: c.subscriber.listenerCount('notesStream'), sent });
}

const cases = [
 ['public', facts(), note()],
 ['self', facts({ user: { id: 'author' } }), note()],
 ['guest', facts({ user: null }), note()],
 ['unfollowed-local', facts({ following: {} }), note()],
 ['remote-followed', facts(), note({ user: { id: 'author', host: 'remote.test' } })],
 ['remote-unfollowed', facts({ following: {} }), note({ user: { id: 'author', host: 'remote.test' } })],
 ['followers', facts(), note({ visibility: 'followers' })],
 ['followers-stale-hide', facts({ hidingFollowing: {} }), note({ visibility: 'followers' })],
 ['home', facts(), note({ visibility: 'home' })],
 ['specified-viewer', facts(), note({ visibility: 'specified', visibleUserIds: ['viewer'] })],
 ['specified-other', facts(), note({ visibility: 'specified', visibleUserIds: ['other'] })],
 ['channel-followed', facts({ followingChannels: ['channel'] }), note({ channelId: 'channel' })],
 ['channel-unfollowed', facts(), note({ channelId: 'channel' })],
 ['with-files-empty', facts(), note(), { withFiles: true }],
 ['with-files-present', facts(), note({ fileIds: ['file'] }), { withFiles: true }],
 ['truthy-files', facts(), note(), { withFiles: 'yes' }],
 ['null-options', facts(), note(), { withFiles: null, withReplies: null, withRenotes: null }],
 ['muted-author', facts({ muting: ['author'] }), note()],
 ['blocked-author', facts({ blockingMe: ['author'] }), note()],
 ['muted-instance', facts({ mutedInstances: ['remote.test'] }), note({ user: { id: 'author', host: 'remote.test' } })],
 ['denied-ltl', facts({ policies: { ltlAvailable: false, gtlAvailable: true } }), note()],
 ['denied-gtl', facts({ policies: { ltlAvailable: true, gtlAvailable: false } }), note()],
 ['guest-ugc-none', facts({ user: null, ugc: 'none' }), note()],
 ['guest-ugc-local-remote', facts({ user: null, ugc: 'local' }), note({ user: { id: 'author', host: 'remote.test' } })],
 ['guest-signin', facts({ user: null }), note({ user: { id: 'author', host: null, requireSigninToViewContents: true } })],
 ['historical-hidden', facts(), note({ user: { id: 'author', host: null, makeNotesHiddenBefore: 0 } })],
];
for (const relation of ['reply', 'renote']) {
 const related = note({ id: relation, userId: 'other', user: { id: 'other', host: null }, reactions: { like: 1 } });
 const outer = { [relation + 'Id']: relation, [relation]: related, text: relation === 'renote' ? null : 'reply' };
 cases.push(
  [`${relation}-ordinary`, facts(), note(outer)],
  [`${relation}-guest`, facts({ user: null }), note(outer)],
  [`${relation}-self`, facts({ user: { id: 'author' } }), note(outer)],
  [`${relation}-viewer`, facts(), note({ ...outer, [relation]: { ...related, userId: 'viewer' } })],
  [`${relation}-muted`, facts({ muting: ['other'] }), note(outer)],
  [`${relation}-blocked`, facts({ blockingMe: ['other'] }), note(outer)],
  [`${relation}-withReplies`, facts(), note(outer), { withReplies: true }],
  [`${relation}-followingReplies`, facts({ following: { author: { withReplies: true } } }), note(outer)],
  [`${relation}-private`, facts(), note({ ...outer, [relation]: { ...related, visibility: 'specified', visibleUserIds: ['other'] } }), { withReplies: true }],
  [`${relation}-followers`, facts(), note({ ...outer, [relation]: { ...related, visibility: 'followers' } }), { withReplies: true }],
  [`${relation}-signin`, facts({ user: null }), note({ ...outer, [relation]: { ...related, user: { id: 'other', host: null, requireSigninToViewContents: true } } })],
 );
}
const renote = note({ id: 'r', reactions: { like: 1 } });
cases.push(
 ['renote-noRenotes', facts(), note({ text: null, renoteId: 'r', renote }), { withRenotes: false }],
 ['renote-muted-author', facts({ renoteMuting: ['author'] }), note({ text: null, renoteId: 'r', renote })],
 ['quote-noRenotes', facts(), note({ text: 'quote', renoteId: 'r', renote }), { withRenotes: false }],
 ['renote-private-reply', facts(), note({ text: null, renoteId: 'r', renote: { ...renote, reply: note({ userId: 'other', visibility: 'followers' }) } })],
);
for (const name of Object.keys(channels)) {
 for (const [id, f, n, params] of cases) {
  if (name === 'hybridTimeline' && !f.user) continue;
  await runChannel(name, id, f, n, params);
 }
}
writeFileSync(process.env.OUTPUT_FILE ?? new URL('source-cases.json', import.meta.url), JSON.stringify({ upstream: sha, blobs: Object.fromEntries([...blobs].map(([file, { blob }]) => [file, blob])), observations: observed }, null, 2) + '\n');
console.log(`Observed ${observed.length} pinned timeline cases`);
