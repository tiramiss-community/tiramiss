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
	'server/api/stream/channels/hashtag.ts',
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
const Hashtag = load('server/api/stream/channels/hashtag.ts').HashtagChannel;
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
	const ch = new Hashtag({ id: 'channel-id', connection: c }, entity, hiding);
	const accepted = await ch.init(params);
	if (c.subscriber.listenerCount('notesStream')) {
		await ch.onNote(copy(n));
	}
	observed.push({ id, input: { facts: data, params, payload: n }, accepted, sent });
	ch.dispose();
	return sent;
}

const cases = [
	['match', facts(), note({ tags: ['misskey'] })],
	['anonymous', facts({ user: null }), note({ tags: ['misskey'] })],
	['and-or', facts(), note({ tags: ['misskey', 'backend'] }), { q: [['missing'], ['MISSKEY', 'backend']] }],
	['and-unmatched', facts(), note({ tags: ['misskey'] }), { q: [['misskey', 'backend']] }],
	['normalization', facts(), note({ tags: ['misskey'] }), { q: [['ＭＩＳＳＫＥＹ']] }],
	['missing-tags', facts(), note()],
	['empty-query', facts(), note({ tags: ['misskey'] }), { q: [] }],
	['invalid-missing', facts(), note({ tags: ['misskey'] }), {}],
	['invalid-scalar', facts(), note({ tags: ['misskey'] }), { q: 'misskey' }],
	['invalid-term', facts(), note({ tags: ['misskey'] }), { q: [['misskey', 0]] }],
	['invalid-conjunction', facts(), note({ tags: ['misskey'] }), { q: [[]] }],
	['invalid-null', facts(), note({ tags: ['misskey'] }), { q: [null] }],
	['no-substring', facts(), note({ tags: ['misskey-next'] })],
	[
		'guest-signin',
		facts({ user: null }),
		note({ tags: ['misskey'], user: { id: 'author', requireSigninToViewContents: true } }),
	],
	['guest-ugc-none', facts({ user: null, ugc: 'none' }), note({ tags: ['misskey'] })],
	[
		'guest-ugc-local',
		facts({ user: null, ugc: 'local' }),
		note({ tags: ['misskey'], user: { id: 'author', host: 'remote.example' } }),
	],
	['muted-author', facts({ muting: ['author'] }), note({ tags: ['misskey'] })],
	['blocked-author', facts({ blockingMe: ['author'] }), note({ tags: ['misskey'] })],
	[
		'muted-instance',
		facts({ mutedInstances: ['remote.example'] }),
		note({ tags: ['misskey'], user: { id: 'author', host: 'remote.example' } }),
	],
	['muted-channel', facts({ mutingChannels: ['channel'] }), note({ tags: ['misskey'], channelId: 'channel' })],
	['private-other', facts(), note({ tags: ['misskey'], visibility: 'specified', visibleUserIds: ['other'] })],
	['private-viewer', facts(), note({ tags: ['misskey'], visibility: 'specified', visibleUserIds: ['viewer'] })],
	['followers-unfollowed', facts({ following: {} }), note({ tags: ['misskey'], visibility: 'followers' })],
	['followers-stale', facts({ hidingFollowing: {} }), note({ tags: ['misskey'], visibility: 'followers' })],
	['historical-hidden', facts(), note({ tags: ['misskey'], user: { id: 'author', makeNotesHiddenBefore: 0 } })],
];
for (const relation of ['reply', 'renote']) {
	const related = note({ id: relation, userId: 'other', user: { id: 'other', host: null }, reactions: { like: 1 } });
	const outer = {
		[relation + 'Id']: relation,
		[relation]: related,
		tags: ['misskey'],
		text: relation === 'renote' ? null : 'reply',
	};
	cases.push(
		[`${relation}-ordinary`, facts(), note(outer)],
		[`${relation}-guest`, facts({ user: null }), note(outer)],
		[`${relation}-quote`, facts(), note({ ...outer, text: 'quote' })],
		[`${relation}-muted`, facts({ muting: ['other'] }), note(outer)],
		[`${relation}-blocked`, facts({ blockingMe: ['other'] }), note(outer)],
		[
			`${relation}-guest-signin`,
			facts({ user: null }),
			note({ ...outer, [relation]: { ...related, user: { id: 'other', requireSigninToViewContents: true } } }),
		],
		[
			`${relation}-private`,
			facts(),
			note({ ...outer, [relation]: { ...related, visibility: 'specified', visibleUserIds: ['other'] } }),
		],
	);
}
cases.push([
	'renote-muted-author',
	facts({ renoteMuting: ['author'] }),
	note({ tags: ['misskey'], renoteId: 'renote', renote: note({ id: 'renote' }), text: null }),
]);
for (const [id, f, n, params = { q: [['misskey']] }] of cases) {
	await runChannel('hashtag', id, f, n, params);
}
const output = {
	upstream: sha,
	blobs: Object.fromEntries([...blobs].map(([file, { blob }]) => [file, blob])),
	observations: observed,
};
writeFileSync(
	process.env.OUTPUT_FILE ?? new URL('source-cases.json', import.meta.url),
	JSON.stringify(output, null, 2) + '\n',
);
console.log(`Observed ${observed.length} pinned hashtag cases`);
