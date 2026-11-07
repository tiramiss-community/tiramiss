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
const sha = '8e07cf085adf7009583d234a208e30436f020e26';
const upstream = process.env.UPSTREAM_ROOT || process.argv[2];
if (!upstream) throw new Error('Set UPSTREAM_ROOT or pass the fixed upstream Git checkout');
const output = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tiramiss-instance-counter-reference-'));
fs.mkdirSync(output, { recursive: true });
const ts = createRequire(path.join(process.env.REPOSITORY_ROOT || path.resolve(__dirname, '../../../../..'), 'package.json'))('typescript');
const sources = {};
function source(file) {
	const text = execFileSync('git', ['-C', upstream, 'show', `${sha}:${file}`], { encoding: 'utf8' });
	sources[file] = { blob: execFileSync('git', ['-C', upstream, 'rev-parse', `${sha}:${file}`], { encoding: 'utf8' }).trim(), sha256: createHash('sha256').update(text).digest('hex') };
	return text;
}
const createFile = 'packages/backend/src/core/NoteCreateService.ts';
const createAst = ts.createSourceFile(createFile, source(createFile), ts.ScriptTarget.Latest, true);
const createClass = createAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'NoteCreateService');
const notificationManager = createAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'NotificationManager');
assert(createClass && notificationManager);
const wanted = ['postNoteCreated', 'index', 'collapseNotesCount', 'performUpdateNotesCount', 'dispose'];
const methods = createClass.members.filter(node => wanted.includes(node.name?.getText(createAst)));
assert.equal(methods.length, wanted.length);
const constructor = createClass.members.find(ts.isConstructorDeclaration);
const controller = createClass.members.find(node => node.name?.getText(createAst) === '#shutdownController');
assert(constructor?.body && controller);
const deleteFile = 'packages/backend/src/core/NoteDeleteService.ts';
const deleteAst = ts.createSourceFile(deleteFile, source(deleteFile), ts.ScriptTarget.Latest, true);
const deleteClass = deleteAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'NoteDeleteService');
const deleteMethod = deleteClass.members.find(node => node.name?.getText(deleteAst) === 'delete');
assert(deleteMethod);
const queueFile = 'packages/backend/src/misc/collapsed-queue.ts';
const queueText = source(queueFile);
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function setup(options = {}) {
	const calls = [];
	const timers = new Map();
	let now = 0;
	let sequence = 0;
	let release;
	const held = new Promise(resolve => { release = resolve; });
	const record = (method, args) => calls.push({ method, ...(args ? { args } : {}) });
	const scope = {
		console, Date, Map, Set, Promise, AbortController,
		bindThis: () => {}, trackPromise: () => {}, isRenote: () => false, isQuote: () => false,
		process: { env: { NODE_ENV: options.testEnvironment ? 'test' : 'production' } },
		setTimeout: (run, delay) => { const id = ++sequence; timers.set(id, { run, delay, at: now + delay }); record('timer-start', { id, delay, at: now }); return id; },
		clearTimeout: id => { timers.delete(id); record('timer-clear', { id }); },
	};
	function compile(text, filename) {
		const moduleValue = { exports: {} };
		vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText,
			{ ...scope, module: moduleValue, exports: moduleValue.exports }, { filename });
		return moduleValue.exports;
	}
	scope.CollapsedQueue = compile(queueText, queueFile).CollapsedQueue;
	const Post = compile(`${notificationManager.getText(createAst)}\nexport class Post {${controller.getText(createAst)}\ninitialize() ${constructor.body.getText(createAst)}\n${methods.map(node => node.getText(createAst)).join('\n')}}`, createFile).Post;
	const Delete = compile(`export class Delete {${deleteMethod.getText(deleteAst)}}`, deleteFile).Delete;
	const repository = {
		increment: async (where, column, value) => {
			record('instance-increment', { where, column, value });
			if (options.holdIncrement) await held;
			if (options.rejectIncrement) throw new Error('increment failed');
			record('instance-increment-finished', { id: where.id });
		},
		decrement: async (where, column, value) => { record('instance-decrement', { where, column, value }); if (options.rejectDecrement) throw new Error('decrement failed'); },
	};
	const meta = { enableStatsForFederatedInstances: options.enabled !== false, enableChartsForFederatedInstances: false };
	const shared = {
		meta, instancesRepository: repository,
		federatedInstanceService: { fetchOrRegister: async host => { record('fetch-or-register', { host }); if (options.rejectFetch) throw new Error('fetch failed'); return { id: 'instance', host }; } },
		userEntityService: { isLocalUser: user => user.host === null, isRemoteUser: user => user.host !== null },
		notesChart: { update() {} }, perUserNotesChart: { update() {} }, instanceChart: { updateNote() { record('instance-chart'); } },
	};
	const post = Object.assign(new Post(), shared, {
		hashtagService: { updateHashtags() {} }, incNotesCountOfUser() {}, pushToTl() {}, antennaService: { addNoteToAntennas() {} },
		followingsRepository: { findBy: async () => [] }, isRenote: () => false, isQuote: () => false,
		activeUsersChart: { write() {} }, noteEntityService: { pack: async () => { record('pack'); if (options.rejectPack) throw new Error('pack failed'); return { id: 'note' }; } },
		globalEventService: { publishNotesStream() {} }, roleService: { addNoteToRoleTimeline() {} }, webhookService: { enqueueUserWebhook() {} },
		createMentionedEvents: async () => {}, searchService: { indexNote: async () => { record('index'); } },
	});
	// The production bindThis decorator binds these callbacks; preserve that binding without loading NestJS.
	post.collapseNotesCount = post.collapseNotesCount.bind(post);
	post.performUpdateNotesCount = post.performUpdateNotesCount.bind(post);
	post.initialize();
	const deletion = Object.assign(new Delete(), shared, {
		searchService: { unindexNote() { record('unindex'); } },
		globalEventService: { publishNoteStream() { record('deleted-publication'); } },
		notesRepository: { delete: async () => { record('db-delete'); if (options.rejectDelete) throw new Error('delete failed'); } },
	});
	return {
		calls, timers, record, post, deletion, release,
		async advance(ms) {
			const until = now + ms;
			while (true) {
				const next = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (!next) break;
				const [id, timer] = next; now = timer.at; timers.delete(id); record('timer-fire', { id, at: now }); timer.run(); await tick();
			}
			now = until;
		},
	};
}
const observations = [];
async function capture(id, options, run) {
	const unhandled = [];
	const listener = error => unhandled.push(error.message);
	process.on('unhandledRejection', listener);
	try {
		const fixture = setup(options);
		await run(fixture);
		await tick();
		observations.push({ id, calls: fixture.calls, unhandledRejectionsCapturedByHarness: unhandled });
		assert.equal(fixture.timers.size, 0, `${id}: unflushed fake timers`);
	} finally { process.off('unhandledRejection', listener); }
}
async function create(fixture, host = 'remote.example') {
	try {
		await fixture.post.postNoteCreated({ id: 'note', userId: 'author', userHost: host, visibility: 'public', text: 'body', cw: null },
			{ id: 'author', username: 'author', host, isBot: false }, { visibility: 'public', localOnly: true }, false, [], []);
	} catch (error) { fixture.record('post-rejected', { message: error.message }); }
	await tick();
}
(async () => {
	for (const [id, options, host] of [['create-local-skipped', {}, null], ['create-disabled-skipped', { enabled: false }, 'remote.example'], ['create-remote-flush', {}, 'remote.example'], ['create-pack-reject-still-enqueues', { rejectPack: true }, 'remote.example'], ['create-registration-reject-independent', { rejectFetch: true }, 'remote.example']]) {
		await capture(id, options, async fixture => { await create(fixture, host); await fixture.post.dispose(); fixture.record('disposed'); });
	}
	for (const [id, options, quiet] of [['delete-remote-immediate', {}, false], ['delete-quiet-skipped', {}, true], ['delete-disabled-skipped', { enabled: false }, false], ['delete-db-reject-retains-decrement', { rejectDelete: true }, false], ['delete-decrement-reject-independent', { rejectDecrement: true }, false], ['delete-registration-reject-independent', { rejectFetch: true }, false]]) {
		await capture(id, options, async fixture => {
			try { await fixture.deletion.delete({ id: 'author', host: 'remote.example' }, { id: 'note', userId: 'author', visibility: 'public', localOnly: true }, quiet); }
			catch (error) { fixture.record('delete-rejected', { message: error.message }); }
			fixture.record('delete-returned'); await tick();
		});
	}
	await capture('batch-first-deadline-not-debounce', {}, async fixture => {
		fixture.post.updateNotesCountQueue.enqueue('a', 1); await fixture.advance(200000); fixture.post.updateNotesCountQueue.enqueue('a', 2);
		await fixture.advance(99999); assert.equal(fixture.calls.filter(call => call.method === 'instance-increment').length, 0);
		await fixture.advance(1); assert.equal(fixture.calls.find(call => call.method === 'instance-increment').args.value, 3); await fixture.post.dispose();
	});
	await capture('batch-independent-instance-deadlines', {}, async fixture => {
		fixture.post.updateNotesCountQueue.enqueue('a', 1); await fixture.advance(100000); fixture.post.updateNotesCountQueue.enqueue('b', 1);
		await fixture.advance(200000); assert.equal(fixture.calls.filter(call => call.method === 'instance-increment').length, 1); await fixture.post.dispose();
	});
	await capture('timer-inflight-new-batch-and-dispose-does-not-wait-old', { holdIncrement: true }, async fixture => {
		try {
			fixture.post.updateNotesCountQueue.enqueue('a', 1); await fixture.advance(300000); await fixture.post.dispose(); fixture.record('dispose-returned-with-inflight');
			assert(!fixture.calls.some(call => call.method === 'instance-increment-finished'));
			fixture.post.updateNotesCountQueue.enqueue('a', 2);
		} finally {
			fixture.release();
			await fixture.post.dispose();
			await tick();
		}
		assert.deepEqual(fixture.calls.filter(call => call.method === 'instance-increment').map(call => call.args.value), [1, 2]);
	});
	await capture('timer-reject-lost-no-retry', { rejectIncrement: true }, async fixture => {
		fixture.post.updateNotesCountQueue.enqueue('a', 1); await fixture.advance(300000); await fixture.post.dispose(); fixture.record('dispose-resolved');
		assert.equal(fixture.calls.filter(call => call.method === 'instance-increment').length, 1);
	});
	await capture('shutdown-flush-reject-all-settled-no-retry', { rejectIncrement: true }, async fixture => {
		fixture.post.updateNotesCountQueue.enqueue('a', 1); fixture.post.updateNotesCountQueue.enqueue('b', 2); await fixture.post.dispose(); fixture.record('dispose-resolved');
		await fixture.post.dispose(); assert.equal(fixture.calls.filter(call => call.method === 'instance-increment').length, 2);
	});
	await capture('source-node-env-test-zero-delay', { testEnvironment: true }, async fixture => {
		fixture.post.updateNotesCountQueue.enqueue('a', 1); assert.equal(fixture.calls[0].args.delay, 0); await fixture.advance(0); await fixture.post.dispose();
	});
	assert.equal(observations.length, 17);
	fs.writeFileSync(path.join(output, 'instance-counter-observations.json'), JSON.stringify({ fixedCommit: sha,
		evidence: 'Complete pinned NoteCreateService.postNoteCreated/index/counter/dispose methods, actual constructor queue initialization, NotificationManager, NoteDeleteService.delete, and complete CollapsedQueue execute from Git blobs. Timers, repositories, registration, packer and other services are doubles. No full server/DB/Redis comparison.', sources, observations }, null, 2) + '\n');
	console.log(JSON.stringify({ output, cases: observations.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
