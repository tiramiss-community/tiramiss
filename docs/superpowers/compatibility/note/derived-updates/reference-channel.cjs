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
if (!upstream) throw new Error('Set UPSTREAM_ROOT or pass the fixed upstream Git checkout as the first argument');
const output = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tiramiss-channel-reference-'));
fs.mkdirSync(output, { recursive: true });
const repository = process.env.REPOSITORY_ROOT || path.resolve(__dirname, '../../../../..');
const ts = createRequire(path.join(repository, 'package.json'))('typescript');
const sources = {};
function source(file) {
	const text = execFileSync('git', ['-C', upstream, 'show', `${sha}:${file}`], { encoding: 'utf8' });
	sources[file] = {
		blob: execFileSync('git', ['-C', upstream, 'rev-parse', `${sha}:${file}`], { encoding: 'utf8' }).trim(),
		sha256: createHash('sha256').update(text).digest('hex'),
	};
	return text;
}
const file = 'packages/backend/src/core/NoteCreateService.ts';
const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
// The delete blob records the audit's other boundary; the five cases execute the complete creation method.
source('packages/backend/src/core/NoteDeleteService.ts');
const classes = ast.statements.filter(ts.isClassDeclaration);
const manager = classes.find(node => node.name?.text === 'NotificationManager');
const creator = classes.find(node => node.name?.text === 'NoteCreateService');
assert(manager && creator);
const wanted = ['postNoteCreated', 'index'];
const members = creator.members.filter(node => wanted.includes(node.name?.getText(ast)));
assert.equal(members.length, wanted.length);
const program = `${manager.getText(ast)}\nexport class PostCreated {${members.map(node => node.getText(ast)).join('\n')}}`;
const moduleValue = { exports: {} };
vm.runInNewContext(ts.transpileModule(program, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText, {
	module: moduleValue, exports: moduleValue.exports,
	bindThis: () => {}, trackPromise: () => {}, console, Date, Map, Set, Promise,
}, { filename: file });
const { PostCreated } = moduleValue.exports;
const observations = [];

(async () => {
	for (const mode of ['success', 'pack-reject', 'mention-reject', 'notes-reject', 'timestamp-reject']) {
		const calls = [];
		const unhandled = [];
		const record = (method, args) => calls.push({ method, ...(args ? { args } : {}) });
		const onUnhandled = error => unhandled.push(error.message);
		process.on('unhandledRejection', onUnhandled);
		try {
			const instance = Object.assign(new PostCreated(), {
				notesChart: { update() {} }, perUserNotesChart: { update() {} }, meta: { enableStatsForFederatedInstances: false },
				hashtagService: { updateHashtags() {} }, incNotesCountOfUser() { record('user-count'); }, pushToTl() {}, antennaService: { addNoteToAntennas() {} },
				followingsRepository: { findBy: async () => [] }, isRenote: () => false, isQuote: () => false,
				userEntityService: { isLocalUser: () => true, isRemoteUser: () => false }, activeUsersChart: { write() {} },
				noteEntityService: { pack: async () => {
					record('pack'); if (mode === 'pack-reject') throw new Error('pack failed'); return { id: 'note' };
				} },
				globalEventService: { publishNotesStream() {} }, roleService: { addNoteToRoleTimeline() {} }, webhookService: { enqueueUserWebhook() {} },
				createMentionedEvents: async () => { record('mention-preparation'); if (mode === 'mention-reject') throw new Error('mention failed'); },
				channelsRepository: {
					increment: async (where, column, amount) => {
						record('channel-increment', { where, column, amount });
						if (mode === 'notes-reject' && column === 'notesCount') throw new Error('notes failed');
					},
					update: async (id, changes) => {
						record('channel-timestamp', { id, keys: Object.keys(changes) });
						if (mode === 'timestamp-reject') throw new Error('timestamp failed');
					},
				},
				notesRepository: { countBy: async where => { record('channel-countBy', where); return 1; } },
				searchService: { indexNote: () => { record('index'); return Promise.resolve(); } },
			});
			let error;
			try {
				await instance.postNoteCreated(
					{ id: 'note', userId: 'author', userHost: null, visibility: 'public', channelId: 'channel', text: 'body', cw: null },
					{ id: 'author', username: 'author', host: null, isBot: false },
					{ visibility: 'public', localOnly: true, channel: { id: 'channel' } }, false, [], [],
				);
			} catch (caught) { error = caught.message; }
			await new Promise(resolve => setImmediate(resolve));
			await new Promise(resolve => setImmediate(resolve));
			const failedPreparation = ['pack-reject', 'mention-reject'].includes(mode);
			assert.equal(Boolean(error), failedPreparation);
			assert.equal(calls.some(call => call.method === 'channel-timestamp'), !failedPreparation);
			assert.equal(calls.some(call => call.method === 'channel-increment' && call.args.column === 'notesCount'), !failedPreparation);
			assert.equal(calls.some(call => call.method === 'channel-increment' && call.args.column === 'usersCount'), !failedPreparation);
			assert.equal(calls.some(call => call.method === 'index'), !failedPreparation);
			assert.equal(unhandled.length, ['notes-reject', 'timestamp-reject'].includes(mode) ? 1 : 0);
			observations.push({ mode, calls, ...(error ? { error } : {}), unhandledRejectionsCapturedByHarness: unhandled });
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	}
	fs.writeFileSync(path.join(output, 'channel-observations.json'), JSON.stringify({
		fixedCommit: sha,
		evidence: 'Complete pinned postNoteCreated/index and NotificationManager execute from Git blobs. Repository/Redis/packer/other services are doubles. No full server, PostgreSQL or Redis comparison. Detached rejection is captured only by this harness.',
		sources, observations,
	}, null, 2) + '\n');
	console.log(JSON.stringify({ output, cases: observations.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
