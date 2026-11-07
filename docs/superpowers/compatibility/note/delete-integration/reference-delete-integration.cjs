/*
 * SPDX-FileCopyrightText: 2026 tiramiss-community
 * SPDX-License-Identifier: AGPL-3.0-only
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const fixedCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const upstream = process.env.UPSTREAM_ROOT || process.argv[2];
if (!upstream) throw new Error('Set UPSTREAM_ROOT or pass the pinned upstream Git checkout');
const output = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tiramiss-delete-integration-'));
fs.mkdirSync(output, { recursive: true });
const repository = process.env.REPOSITORY_ROOT || path.resolve(__dirname, '../../../../..');
const ts = createRequire(path.join(repository, 'package.json'))('typescript');
const sources = {};
function source(file) {
	const text = execFileSync('git', ['-C', upstream, 'show', `${fixedCommit}:${file}`], { encoding: 'utf8' });
	sources[file] = {
		blob: execFileSync('git', ['-C', upstream, 'rev-parse', `${fixedCommit}:${file}`], { encoding: 'utf8' }).trim(),
		sha256: createHash('sha256').update(text).digest('hex'),
	};
	return text;
}
const fixedNow = 1730000000000;
class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [fixedNow])); }
	static now() { return fixedNow; }
}
const clone = value => JSON.parse(JSON.stringify(value));
const decorator = () => () => {};
const renoteFile = 'packages/backend/src/misc/is-renote.ts';
function compile(text, filename, extra = {}) {
	const module = { exports: {} };
	vm.runInNewContext(ts.transpileModule(text, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
	}).outputText, {
		module, exports: module.exports, Date: FixedDate, Map, Set, Promise, console, AbortController,
		Injectable: decorator, Inject: decorator, bindThis: () => {}, DI: {}, trackPromise: () => {},
		In: values => ({ in: values }), IsNull: () => ({ isNull: true }), Not: value => ({ not: value }),
		Brackets: class { constructor(callback) { this.callback = callback; } },
		Math: Object.assign(Object.create(Math), { random: () => 0 }),
		...extra,
	}, { filename });
	return module.exports;
}
const renote = compile(source(renoteFile), renoteFile);
function ast(file) { return ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true); }
function getClass(tree, name) {
	const found = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
	assert(found, name);
	return found;
}
const deleteFile = 'packages/backend/src/core/NoteDeleteService.ts';
const deleteAst = ast(deleteFile);
const deleteCallTargets = new Set();
function collectCalls(node) {
	if (ts.isCallExpression(node)) deleteCallTargets.add(node.expression.getText(deleteAst));
	ts.forEachChild(node, collectCalls);
}
collectCalls(getClass(deleteAst, 'NoteDeleteService'));
// The entire class, including all concerned-recipient helpers, is executed without rewriting its bodies.
const Delete = compile(getClass(deleteAst, 'NoteDeleteService').getText(deleteAst), deleteFile, renote).NoteDeleteService;
const searchFile = 'packages/backend/src/core/SearchService.ts';
const searchAst = ast(searchFile);
const Search = compile(getClass(searchAst, 'SearchService').getText(searchAst), searchFile).SearchService;
const createFile = 'packages/backend/src/core/NoteCreateService.ts';
const createAst = ast(createFile);
const creator = getClass(createAst, 'NoteCreateService');
const methods = ['postNoteCreated', 'index', 'isRenote', 'isQuote', 'incRenoteCount', 'saveReply', 'createMentionedEvents', 'renderNoteOrRenoteActivity'];
const members = creator.members.filter(node => methods.includes(node.name?.getText(createAst)));
assert.equal(members.length, methods.length);
const createMethod = creator.members.find(node => node.name?.getText(createAst) === 'create');
const scheduledPost = createMethod.body.statements.find(node => node.getText(createAst).startsWith("setImmediate('post created'"));
const shutdownField = creator.members.find(node => node.name?.getText(createAst) === '#shutdownController');
assert(scheduledPost && shutdownField);
let scheduleImmediate;
const Created = compile(`${getClass(createAst, 'NotificationManager').getText(createAst)}\nexport class Created {
${shutdownField.getText(createAst)}
${members.map(node => node.getText(createAst)).join('\n')}
schedulePost(note, user, data, silent, tags, mentionedUsers) { ${scheduledPost.getText(createAst)} }
}`, createFile, { setImmediate: (...args) => scheduleImmediate(...args) }).Created;
const pollFile = 'packages/backend/src/queue/processors/EndedPollNotificationProcessorService.ts';
const pollAst = ast(pollFile);
const PollEnded = compile(getClass(pollAst, 'EndedPollNotificationProcessorService').getText(pollAst), pollFile).EndedPollNotificationProcessorService;

// These fixed blobs identify schema facts for the adjacent real-DB integration, not simulated cascade proof.
for (const file of ['packages/backend/src/models/Note.ts', 'packages/backend/src/models/Poll.ts', 'packages/backend/src/models/PollVote.ts', 'packages/backend/src/models/NoteReaction.ts', 'packages/backend/migration/1753868431598-remove_note_constraints.js']) source(file);

function deferred() {
	let release;
	const promise = new Promise(resolve => { release = resolve; });
	return { promise, release };
}
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function world(options = {}) {
	const calls = [];
	const pending = [];
	const holds = [];
	const record = (method, args) => calls.push({ method, ...(args === undefined ? {} : { args: clone(args) }) });
	const state = {
		noteExists: true, parentReplies: 3, parentRenotes: 7, userCount: 5, channelCount: 4,
		ordinaryTimeline: ['retained'], roleTimeline: ['retained'], antennaTimeline: ['retained'],
		hashtags: ['retained'], featured: ['retained'], notifications: ['retained'], webhooks: [],
		searchDocumentExists: true,
	};
	const user = { id: 'author', username: 'author', host: options.remote ? 'remote.example' : null, uri: null, isBot: false };
	const note = {
		id: 'note', userId: user.id, userHost: user.host, visibility: 'public', localOnly: false,
		text: 'body', cw: null, channelId: 'channel', tags: ['tag'], fileIds: [],
		replyId: 'parent', renoteId: null, renoteUserId: null, hasPoll: true,
		mentionedRemoteUsers: JSON.stringify([{ uri: 'https://mentioned.example/user' }]),
		visibleUserIds: [], ...options.note,
	};
	const parent = { id: 'parent', userId: 'other', userHost: null, channelId: null, replyId: null, visibility: 'public' };
	const hold = () => { const value = deferred(); holds.push(value); return value; };
	const addHold = options.holdAdd ? hold() : null;
	const packHold = options.holdPack ? hold() : null;
	const scheduleHold = options.holdSchedule ? hold() : null;
	scheduleImmediate = (value, options) => { record('post-create-scheduled', { value, aborted: options.signal.aborted }); return scheduleHold ? scheduleHold.promise : Promise.resolve(); };
	const track = promise => { pending.push(promise); return promise; };
	const search = new Search({ meilisearch: { index: 'fixture', scope: 'global' } }, {
		index: () => ({
			updateSettings: async () => {},
			addDocuments: (documents, settings) => track((async () => {
				record('search-add-start', { documents, settings });
				if (addHold) await addHold.promise;
				state.searchDocumentExists = true; record('search-add-accepted');
			})()),
			deleteDocument: id => track((async () => {
				record('search-delete-start', { id });
				if (options.failSearch) throw new Error('unindex failed');
				state.searchDocumentExists = false; record('search-delete-accepted');
			})()),
		}),
	}, {}, {}, {}, { parse: () => ({ date: new FixedDate(fixedNow) }) }, { getLogger: () => ({ info() {} }) }, {});
	const query = {
		leftJoinAndSelect() { return this; }, where() { return this; }, andWhere() { return this; },
		getMany: async () => { record('concerned-descendant-query'); return [{ user: { id: 'remote-child-author', host: 'child.example' } }]; },
		update() { return this; }, set() { return this; },
		execute: async () => { state.parentRenotes++; record('renote-count-increment'); },
	};
	const notesRepository = {
		decrement: async (where, column, amount) => {
			record('reply-count-decrement', { where, column, amount });
			if (options.failReply) throw new Error('reply decrement failed');
			state.parentReplies -= amount;
		},
		delete: async where => {
			record('db-delete', { where });
			if (options.failDelete) throw new Error('DB DELETE failed');
			state.noteExists = false;
		},
		findOneBy: async where => { record('renote-original-query', { where }); if (options.failOriginal) throw new Error('original lookup failed'); return options.missingOriginal ? null : { id: 'original', uri: 'https://original.example/note' }; },
		createQueryBuilder: () => query,
		increment: async (where, column, amount) => { state.parentReplies += amount; record('reply-count-increment', { where, column, amount }); },
		countBy: async () => 1,
	};
	const renderer = {
		renderTombstone: uri => { record('render-tombstone', { uri }); return { type: 'Tombstone', id: uri }; },
		renderDelete: tombstone => { record('render-delete'); return { type: 'Delete', object: tombstone }; },
		renderAnnounce: uri => { record('render-announce', { uri }); return { type: 'Announce', object: uri }; },
		renderUndo: announce => { record('render-undo'); return { type: 'Undo', object: announce }; },
		addContext: content => { if (options.failRender) throw new Error('render failed'); return content; },
		renderNote: async () => { record('render-create-note'); return { id: note.id }; },
		renderCreate: object => ({ type: 'Create', object }),
	};
	const userEntityService = { isLocalUser: value => value.host == null, isRemoteUser: value => value.host != null };
	const events = {
		publishNoteStream: (value, type, body) => { record('deleted-stream', { id: value.id, type, body }); if (options.failStream) throw new Error('stream failed'); },
		publishNotesStream: value => record('created-stream', { id: value.id }),
		publishMainStream: (userId, type) => record('main-stream', { userId, type }),
	};
	const deletion = Object.assign(Object.create(Delete.prototype), {
		config: { url: 'https://local.example' }, meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: true, enableChartsForFederatedInstances: false },
		notesRepository, usersRepository: {
			find: async () => { record('concerned-mentioned-query'); return [{ id: 'mentioned', host: 'mentioned.example' }]; },
			findOneByOrFail: async () => { record('audit-author-query'); return user; },
		},
		instancesRepository: { decrement: async (where, column, amount) => record('instance-count-decrement', { where, column, amount }) },
		userEntityService, globalEventService: events, apRendererService: renderer, searchService: search,
		federatedInstanceService: { fetchOrRegister: async host => { record('instance-register', { host }); return { id: 'instance', host }; } },
		notesChart: { update: (value, created) => record('notes-chart', { created }) },
		perUserNotesChart: { update: (value, row, created) => record('user-chart', { created }) },
		relayService: { deliverToRelays: async (value, activity) => record('relay-delivery', { type: activity.type }) },
		apDeliverManagerService: {
			deliverToFollowers: async (value, activity) => record('follower-delivery', { type: activity.type }),
			deliverToUsers: async (value, activity, users) => record('direct-delivery', { type: activity.type, ids: users.map(row => row.id) }),
		},
		moderationLogService: { log: async (actor, type, body) => record('moderator-audit', { actor: actor.id, type, noteId: body.noteId }) },
	});
	const creation = Object.assign(new Created(), {
		config: { url: 'https://local.example' }, meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false },
		notesChart: { update: () => record('create-chart') }, perUserNotesChart: { update: () => record('create-user-chart') },
		activeUsersChart: { write: () => record('active-user-chart') },
		hashtagService: { updateHashtags: () => { state.hashtags.push('tag'); record('hashtag-update'); } },
		incNotesCountOfUser: () => { state.userCount++; record('user-count-increment'); },
		pushToTl: () => { state.ordinaryTimeline.push(note.id); record('ordinary-timeline-add'); },
		antennaService: { addNoteToAntennas: () => { state.antennaTimeline.push(note.id); record('antenna-timeline-add'); } },
		roleService: { addNoteToRoleTimeline: () => { state.roleTimeline.push(note.id); record('role-timeline-add'); } },
		featuredService: {
			updateGlobalNotesRanking: id => { state.featured.push(id); record('featured-global-add'); },
			updatePerUserNotesRanking: () => record('featured-user-add'),
		},
		idService: { parse: () => ({ date: new FixedDate(fixedNow) }) }, notesRepository,
		followingsRepository: { findBy: async () => [] },
		noteThreadMutingsRepository: { exists: async () => false },
		queueService: { endedPollNotificationQueue: { add: async (id, data, options) => record('poll-job-add', { id, data, options }) } },
		noteEntityService: { pack: async (value, viewer) => {
			record('pack', { viewer: viewer?.id ?? null });
			if (packHold && !viewer) await packHold.promise;
			if (options.failPack || (options.failMention && viewer)) throw new Error(viewer ? 'mention pack failed' : 'pack failed');
			return { id: note.id, packed: true };
		} },
		notificationService: { createNotification: (id, type) => { state.notifications.push(type); record('notification-create', { id, type }); } },
		webhookService: { enqueueUserWebhook: (id, type) => { state.webhooks.push(type); record('webhook-enqueue', { id, type }); } },
		userEntityService, globalEventService: events, apRendererService: renderer, searchService: search,
		channelsRepository: {
			increment: async (where, column) => { if (column === 'notesCount') state.channelCount++; record('channel-increment', { column }); },
			update: async () => record('channel-timestamp'),
		},
		apDeliverManagerService: { createDeliverManager: () => ({ addFollowersRecipe() {}, execute: async () => record('create-delivery') }) },
		relayService: { deliverToRelays: async (value, activity) => record('create-relay', { type: activity.type }) },
	});
	const creationArgs = [note, user, { visibility: 'public', localOnly: false, channel: { id: 'channel' }, reply: parent, renote: parent, ...(note.hasPoll ? { poll: { expiresAt: new FixedDate(fixedNow + 60000) } } : {}) }, false, ['tag'], [{ id: 'mentioned-local', host: null }]];
	return {
		calls, state, note, user, deletion, record, holds, addHold, packHold,
		scheduleHold,
		create: () => creation.postNoteCreated(...creationArgs),
		scheduleCreate: () => creation.schedulePost(...creationArgs),
		pollAfterDelete: async () => {
			const worker = Object.assign(Object.create(PollEnded.prototype), {
				notesRepository: { findOneBy: async () => { record('poll-current-note-read'); return state.noteExists ? note : null; } },
				pollVotesRepository: { createQueryBuilder: () => { throw new Error('deleted poll must not query voters'); } },
			});
			await worker.process({ data: { noteId: note.id } });
		},
		finish: async () => { for (const held of holds) held.release(); await Promise.allSettled(pending); await tick(); },
	};
}

const observations = [];
async function run(id, options, action) {
	const fixture = world(options);
	const unhandled = [];
	const onUnhandled = error => unhandled.push(error.message);
	process.on('unhandledRejection', onUnhandled);
	try {
		await action(fixture);
		await fixture.finish();
		observations.push({ id, calls: fixture.calls, state: clone(fixture.state), unhandledRejectionsCapturedByHarness: unhandled });
	} finally {
		await fixture.finish();
		process.off('unhandledRejection', onUnhandled);
	}
}
async function deleteAndRecord(fixture, quiet = false, moderator = true) {
	try { await fixture.deletion.delete(fixture.user, fixture.note, quiet, moderator ? { id: 'moderator' } : undefined); fixture.record('delete-returned'); }
	catch (error) { fixture.record('delete-rejected', { message: error.message }); }
}

(async () => {
	for (const [id, options] of [
		['success', {}], ['db-delete-reject', { failDelete: true }], ['reply-decrement-reject', { failReply: true }],
		['stream-throws', { failStream: true }], ['render-throws', { failRender: true }], ['unindex-reject-independent', { failSearch: true }],
		['local-only', { note: { localOnly: true } }], ['remote-author', { remote: true }],
		['pure-renote-undo', { note: { text: null, replyId: null, renoteId: 'original', hasPoll: false } }],
		['pure-renote-missing-original', { missingOriginal: true, note: { text: null, replyId: null, renoteId: 'original', hasPoll: false } }],
		['pure-renote-original-query-reject', { failOriginal: true, note: { text: null, replyId: null, renoteId: 'original', hasPoll: false } }],
	]) await run(id, options, async fixture => {
		await deleteAndRecord(fixture);
		if (id === 'success') await fixture.pollAfterDelete();
	});
	await run('quiet-delete', {}, fixture => deleteAndRecord(fixture, true));
	for (const [id, options] of [['create-pack-reject-then-delete', { failPack: true }], ['create-mention-reject-then-delete', { failMention: true }]]) {
		await run(id, options, async fixture => {
			try { await fixture.create(); } catch (error) { fixture.record('create-rejected', { message: error.message }); }
			await tick(); fixture.record('before-delete'); await deleteAndRecord(fixture);
		});
	}
	await run('create-pack-held-until-after-delete', { holdPack: true, note: { hasPoll: false } }, async fixture => {
		const creating = fixture.create();
		try {
			fixture.record('pack-held'); await deleteAndRecord(fixture);
			fixture.record('release-pack'); fixture.packHold.release(); await creating; fixture.record('create-returned');
		} finally { fixture.packHold.release(); await Promise.allSettled([creating]); }
	});
	await run('scheduled-post-created-held-until-after-delete', { holdSchedule: true, note: { hasPoll: false } }, async fixture => {
		fixture.scheduleCreate(); fixture.record('creation-caller-returned');
		await deleteAndRecord(fixture); fixture.record('release-post-created'); fixture.scheduleHold.release();
		await tick();
	});
	await run('create-search-add-held-until-after-delete', { holdAdd: true }, async fixture => {
		await fixture.create(); fixture.record('create-returned');
		assert(fixture.calls.some(call => call.method === 'search-add-start'));
		await deleteAndRecord(fixture); fixture.record('after-delete-before-add-release', { searchDocumentExists: fixture.state.searchDocumentExists });
		fixture.record('release-search-add'); fixture.addHold.release();
	});
	// Assertions validate the measured boundaries; saved observations always come from the source execution above.
	const byId = id => observations.find(row => row.id === id);
	const names = row => row.calls.map(call => call.method);
	assert(names(byId('success')).indexOf('search-delete-start') < names(byId('success')).indexOf('db-delete'));
	assert.equal(byId('db-delete-reject').state.noteExists, true);
	assert.equal(byId('db-delete-reject').state.parentReplies, 2);
	assert(!names(byId('db-delete-reject')).includes('moderator-audit'));
	assert(!names(byId('reply-decrement-reject')).includes('deleted-stream'));
	assert(!names(byId('render-throws')).includes('db-delete'));
	assert.equal(byId('unindex-reject-independent').state.noteExists, false);
	assert(!names(byId('quiet-delete')).includes('deleted-stream'));
	assert(names(byId('quiet-delete')).includes('search-delete-start'));
	assert(names(byId('pure-renote-undo')).includes('render-undo'));
	assert(names(byId('pure-renote-missing-original')).includes('render-delete'));
	for (const id of ['create-pack-reject-then-delete', 'create-mention-reject-then-delete']) assert(!names(byId(id)).includes('search-add-start'));
	const late = byId('create-pack-held-until-after-delete');
	assert(names(late).indexOf('db-delete') < names(late).indexOf('search-add-start'));
	assert.equal(late.state.noteExists, false);
	assert.equal(late.state.searchDocumentExists, true);
	assert.equal(byId('create-search-add-held-until-after-delete').state.searchDocumentExists, true);
	const scheduled = byId('scheduled-post-created-held-until-after-delete');
	assert(names(scheduled).indexOf('db-delete') < names(scheduled).indexOf('create-chart'));
	assert.equal(scheduled.state.noteExists, false);
	assert.equal(scheduled.state.searchDocumentExists, true);
	for (const row of [late, scheduled]) assert(!names(row).includes('poll-job-add'), row.id);
	assert(names(byId('success')).indexOf('delete-returned') < names(byId('success')).indexOf('poll-current-note-read'));
	for (const row of observations) {
		const rejected = row.calls.find(call => call.method === 'delete-rejected');
		assert.equal(Boolean(rejected), ['db-delete-reject', 'reply-decrement-reject', 'stream-throws', 'render-throws', 'pure-renote-original-query-reject'].includes(row.id), row.id);
		assert.equal(row.unhandledRejectionsCapturedByHarness.length, row.id === 'unindex-reject-independent' ? 1 : 0, row.id);
	}
	fs.writeFileSync(path.join(output, 'observations.json'), JSON.stringify({
		fixedCommit,
		evidence: 'Complete pinned NoteDeleteService class and helpers; complete pinned SearchService class; complete postNoteCreated and listed creation methods plus NotificationManager; unmodified scheduled-post-created statement and shutdown field from create, in a harness wrapper; complete poll-ended processor checks missing Note after success deletion. The two held late-creation success cases use non-poll Note/data and a successful packer double; actual Poll/Vote packing is not exercised and could fail. Repository, renderer, packer, producer services, SDK engine, scheduler, clock and randomness are doubles. Mock retained arrays only complement complete Delete AST call absence; no upstream HTTP server, PostgreSQL, Redis, Meilisearch task application, AP rendering, full create method or cascade execution. Detached rejections are captured by the harness. Held promises are released in finally.',
		creationMethods: methods, deleteCallTargets: [...deleteCallTargets].sort(), sources, observations,
	}, null, 2) + '\n');
	console.log(JSON.stringify({ output, cases: observations.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
