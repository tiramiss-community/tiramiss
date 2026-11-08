/*
 * SPDX-FileCopyrightText: 2026 tiramiss-community
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Execute pinned source with explicit doubles; no Redis or full upstream application.
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
assert(upstream, 'Pass the pinned upstream Git checkout, or set UPSTREAM_ROOT');
const repository = process.env.REPOSITORY_ROOT || path.resolve(__dirname, '../../../..');
const ts = createRequire(path.join(repository, 'package.json'))('typescript');
const prefix = 'packages/backend/src/';
const sources = {};
const texts = new Map();
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const observations = [];
const now = 1800000000000;
class Clock extends Date {
	constructor(...args) { super(...(args.length ? args : [now])); }
	static now() { return now; }
}
function source(file) {
	if (!texts.has(file)) {
		const text = execFileSync('git', ['-C', upstream, 'show', `${fixedCommit}:${file}`], { encoding: 'utf8' });
		texts.set(file, text);
		sources[file] = {
			blob: execFileSync('git', ['-C', upstream, 'rev-parse', `${fixedCommit}:${file}`], { encoding: 'utf8' }).trim(),
			sha256: createHash('sha256').update(text).digest('hex'),
		};
	}
	return texts.get(file);
}
function tree(file) { return ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true); }
function members(file, name, wanted) {
	const ast = tree(file);
	const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
	assert(cls, name);
	const found = cls.members.filter(node => wanted.includes(node.name?.getText(ast)));
	assert.equal(found.length, wanted.length);
	return found.map(node => node.getText(ast)).join('\n');
}
const cache = new Map();
let moduleDefinition;
const queueConstructions = [];
let pendingDrain = Promise.resolve();
const noopDecorator = () => () => {};
const stubs = {
	'@nestjs/common': { Inject: noopDecorator, Injectable: noopDecorator, Module: value => { moduleDefinition = value; return () => {}; } },
	'bullmq': { MetricsTime: { ONE_WEEK: 10080 }, Queue: class {
		constructor(name, options) { this.name = name; this.options = options; queueConstructions.push({ name, options: clone(options) }); }
	} },
	'@/di-symbols.js': { DI: {} },
	'@/decorators.js': { bindThis: () => {} },
	'@/misc/promise-tracker.js': { allSettled: () => pendingDrain },
	'@/core/activitypub/ApRequestService.js': { ApRequestCreator: { createDigest: body => `double-digest:${body}` } },
	'node:crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
};
function compile(text, filename, extra = {}) {
	const module = { exports: {} };
	const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
	vm.runInNewContext(output, { Date: Clock, console, Map, Set, Promise, Math, ...extra, module, exports: module.exports,
		require: specifier => {
			if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
			const resolved = specifier.startsWith('@/') ? `${prefix}${specifier.slice(2)}` : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier)) : null;
			assert(resolved, `Unsupported source dependency ${specifier} in ${filename}`);
			return load(resolved.replace(/\.js$/, '.ts'));
		},
	}, { filename });
	return module.exports;
}
function load(file) {
	if (!cache.has(file)) cache.set(file, compile(source(file), file));
	return cache.get(file);
}
function observe(id, layer, input, expected) { observations.push({ id, layer, input: clone(input), expected: clone(expected) }); }
const config = { redisForJobQueue: { prefix: 'fixture', host: 'redis.example', port: 6379, keyPrefix: 'must-not-reach-client' } };
const { QueueService, QUEUE_TYPES } = load(`${prefix}core/QueueService.ts`);
const { QUEUE, baseQueueOptions, baseWorkerOptions } = load(`${prefix}queue/const.ts`);
const { QueueModule } = load(`${prefix}core/QueueModule.ts`);
const queueTypes = clone(QUEUE_TYPES);
assert.equal(queueTypes.length, 10);
const calls = [];
function queues(schedulers = []) {
	return queueTypes.map(queue => ({
		add: (...args) => { calls.push({ queue, method: 'add', args: clone(args) }); return Promise.resolve({ id: 'job' }); },
		addBulk: (...args) => { calls.push({ queue, method: 'addBulk', args: clone(args) }); return Promise.resolve([]); },
		upsertJobScheduler: (...args) => { calls.push({ queue, method: 'upsertJobScheduler', args: clone(args) }); return Promise.resolve(); },
		getJobSchedulers: () => { calls.push({ queue, method: 'getJobSchedulers', args: [] }); return Promise.resolve(schedulers); },
		removeJobScheduler: (...args) => { calls.push({ queue, method: 'removeJobScheduler', args: clone(args) }); return Promise.resolve(); },
		getJob: () => Promise.resolve(null),
		clean: (...args) => { calls.push({ queue, method: 'clean', args: clone(args) }); return Promise.resolve([]); },
		close: (...args) => { calls.push({ queue, method: 'close', args: clone(args) }); return Promise.resolve(); },
	}));
}

async function run() {
	// Every actual provider factory passes through the actual createQueue/baseQueueOptions functions.
	for (const provider of moduleDefinition.providers) provider.useFactory(config);
	assert.deepEqual(queueConstructions.map(item => item.name), queueTypes);
	assert(queueConstructions.every(item => !Object.hasOwn(item.options, 'defaultJobOptions')));
	observe('all-queue-constructors', 'queue-provider-factory', { config }, { queues: queueConstructions });
	observe('prefix-without-configured-prefix', 'base-queue-options', { redisForJobQueue: { host: 'redis.example', port: 6379 } }, baseQueueOptions({ redisForJobQueue: { host: 'redis.example', port: 6379 } }, QUEUE.DELIVER));

	// Execute the ten entire third-argument expressions, with the actual baseWorkerOptions function.
	// The processor callbacks are deliberately not evaluated or represented as functional workers.
	const workerFile = `${prefix}queue/QueueProcessorService.ts`;
	const workerTree = tree(workerFile);
	const workerExpressions = [];
	function visit(node) {
		if (ts.isNewExpression(node) && node.expression.getText(workerTree) === 'Bull.Worker') workerExpressions.push(node);
		ts.forEachChild(node, visit);
	}
	visit(workerTree);
	assert.equal(workerExpressions.length, 10);
	const workerOptions = [];
	for (const expression of workerExpressions) {
		const queue = vm.runInNewContext(expression.arguments[0].getText(workerTree), { QUEUE });
		const optionsText = expression.arguments[2].getText(workerTree);
		const { evaluate } = compile(`export function evaluate() { return (${optionsText}); }`, workerFile, { QUEUE, baseWorkerOptions, httpRelatedBackoff: () => { throw new Error('Backoff execution outside retention probe'); } });
		const options = evaluate.call({ config });
		assert(!Object.hasOwn(options, 'removeOnComplete') && !Object.hasOwn(options, 'removeOnFail'));
		assert.equal(options.autorun, false);
		workerOptions.push({ queue, sourceLine: workerTree.getLineAndCharacterOfPosition(expression.getStart(workerTree)).line + 1, options: clone(options), customBackoff: typeof options.settings?.backoffStrategy === 'function', retentionFallback: null });
	}
	observe('all-worker-options', 'worker-option-expression', { config }, { workers: workerOptions });
	const workerMethods = compile(`export class Lifecycle { ${members(workerFile, 'QueueProcessorService', ['start', 'stop', 'onApplicationShutdown'])} }`, workerFile, { bindThis: () => {} }).Lifecycle;
	const workerLifecycle = new workerMethods();
	for (const queue of queueTypes) workerLifecycle[`${queue}QueueWorker`] = {
		run: async () => calls.push({ queue, method: 'run' }),
		close: async () => calls.push({ queue, method: 'close' }),
	};
	for (const method of ['start', 'onApplicationShutdown']) {
		calls.length = 0;
		await workerLifecycle[method]();
		assert.equal(calls.length, 10);
		observe(`workers-${method}`, 'worker-lifecycle-method', {}, { calls });
	}

	calls.length = 0;
	const queueDoubles = queues([{ key: 'clean' }, { key: 'legacy-system-job' }]);
	const service = new QueueService(config, ...queueDoubles);
	await Promise.resolve();
	observe('system-scheduler-constructor', 'queue-service-constructor', { existingSchedulers: [{ key: 'clean' }, { key: 'legacy-system-job' }] }, { calls });
	const schedulerCalls = calls.filter(call => call.method === 'upsertJobScheduler');
	assert.equal(schedulerCalls.length, 9);
	assert(schedulerCalls.every(call => call.args[1].immediately === false && call.args[2].opts.removeOnComplete.age === 604800 && !Object.hasOwn(call.args[2].opts.removeOnComplete, 'count')));

	const user = { id: 'user' };
	const relation = [{ from: user, to: { id: 'target' }, silent: false, withReplies: true }];
	const webhook = { id: 'hook', userId: 'user', url: 'https://hook.example/path', secret: 'fixture-secret' };
	const producerCases = [
		['deliver', [user, { type: 'Create' }, 'https://remote.example/inbox', false]],
		['deliverMany', [user, { type: 'Create' }, new Map([['https://remote.example/inbox', false], ['https://shared.example/inbox', true]])]],
		['inbox', [{ id: 'https://remote.example/activity' }, { keyId: 'key' }]],
		['scheduleAnnouncementArchive', ['announcement', new Clock(now + 5000)]],
		...['DeleteDriveFiles', 'ExportCustomEmojis', 'ExportNotes', 'ExportClips', 'ExportFavorites', 'ExportFollowing', 'ExportMute', 'ExportBlocking', 'ExportUserLists', 'ExportAntennas', 'DeleteAccount'].map(name => [`create${name}Job`, [user]]),
		...['ImportFollowing', 'ImportMuting', 'ImportBlocking', 'ImportUserLists', 'ImportCustomEmojis'].map(name => [`create${name}Job`, [user, 'file']]),
		['createImportAntennasJob', [user, { name: 'antenna' }]],
		['createImportFollowingToDbJob', [user, ['target1', 'target2'], true]],
		['createImportBlockingToDbJob', [user, ['target1', 'target2']]],
		...['Follow', 'Unfollow', 'Block', 'Unblock'].map(name => [`create${name}Job`, [relation]]),
		['createDelayedUnfollowJob', [relation, 5000]],
		['createDeleteObjectStorageFileJob', ['object-key']], ['createCleanRemoteFilesJob', []],
		['userWebhookDeliver', [webhook, 'note', { note: { id: 'note' } }]],
		['systemWebhookDeliver', [webhook, 'abuseReport', { id: 'report' }]],
	];
	const producers = [];
	for (const [method, args] of producerCases) {
		calls.length = 0;
		await service[method](...args);
		assert.equal(calls.length, 1, method);
		const call = calls[0];
		producers.push({ producer: method, queue: call.queue, method: call.method, jobs: call.method === 'add' ? [{ name: call.args[0], opts: call.args[2] }] : call.args[0].map(job => ({ name: job.name, opts: job.opts })) });
		const options = call.method === 'add' ? [call.args[2]] : call.args[0].map(job => job.opts);
		for (const opts of options) {
			assert.deepEqual(opts.removeOnComplete, { age: 604800, count: 30 });
			assert.deepEqual(opts.removeOnFail, { age: 604800, count: 100 });
		}
	}
	observe('all-queue-service-producer-options', 'queue-service-producer', { methods: producerCases.map(([method]) => method), fixture: 'user, webhook, two bulk targets; arguments declared in executable probe; payload omitted from this retention projection' }, { producers });
	const override = service.generateRelationshipJobData('unfollow', relation[0], { delay: 7, removeOnComplete: true, removeOnFail: false });
	observe('relationship-options-explicit-override', 'queue-service-private-helper', { opts: { delay: 7, removeOnComplete: true, removeOnFail: false } }, override);
	assert.equal(override.opts.removeOnComplete, true);
	for (const [method, args] of [['deliver', [user, null, 'url', false]], ['deliver', [user, {}, null, false]], ['deliverMany', [user, null, new Map()]]]) {
		calls.length = 0;
		const result = await service[method](...args);
		observe(`skip-${method}-${args[1] === null ? 'null-content' : 'null-to'}`, 'queue-service-producer', { method, content: args[1], to: args[2] }, { result, calls });
		assert.equal(calls.length, 0);
	}

	// Complete source poll conditional from postNoteCreated, not a copy of its job options.
	const noteFile = `${prefix}core/NoteCreateService.ts`;
	const noteTree = tree(noteFile);
	const pollBlocks = [];
	function findPoll(node) {
		if (ts.isIfStatement(node) && node.expression.getText(noteTree) === 'data.poll && data.poll.expiresAt') pollBlocks.push(node);
		ts.forEachChild(node, findPoll);
	}
	findPoll(noteTree);
	assert.equal(pollBlocks.length, 1);
	const poll = compile(`export function poll(data, note) { ${pollBlocks[0].getText(noteTree)} }`, noteFile).poll;
	for (const delay of [5000, -5000]) {
		calls.length = 0;
		poll.call({ queueService: service }, { poll: { expiresAt: new Clock(now + delay) } }, { id: 'note' });
		observe(`poll-ended-delay-${delay}`, 'post-note-created-poll-conditional', { delay }, { calls });
	}
	const draftFile = `${prefix}core/NoteDraftService.ts`;
	const Schedule = compile(`export class Schedule { ${members(draftFile, 'NoteDraftService', ['schedule'])} }`, draftFile, { bindThis: () => {} }).Schedule;
	const schedule = Object.assign(new Schedule(), { queueService: service });
	for (const [id, draft] of [['future', { id: 'draft', isActuallyScheduled: true, scheduledAt: new Clock(now + 5000) }], ['past', { id: 'draft', isActuallyScheduled: true, scheduledAt: new Clock(now - 1) }], ['disabled', { id: 'draft', isActuallyScheduled: false, scheduledAt: new Clock(now + 5000) }], ['no-date', { id: 'draft', isActuallyScheduled: true, scheduledAt: null }]]) {
		calls.length = 0;
		await schedule.schedule(draft);
		observe(`scheduled-note-${id}`, 'note-draft-schedule-method', draft, { calls });
	}

	for (const state of ['completed', 'failed', '*']) {
		calls.length = 0;
		await service.queueClear('deliver', state);
		observe(`manual-clear-${state}`, 'queue-service-management', { queue: 'deliver', state }, { calls });
	}
	// Actual clean process; repository/query/logger/Reversi are doubles, with expired-role data supplied.
	const cleanFile = `${prefix}queue/processors/CleanProcessorService.ts`;
	const Clean = compile(`export class Clean { ${members(cleanFile, 'CleanProcessorService', ['process'])} }`, cleanFile, { bindThis: () => {}, LessThan: value => ({ lessThan: value }), In: value => ({ in: value }) }).Clean;
	for (const threshold of [0, 86400000]) {
		calls.length = 0;
		const query = { where: (...args) => { calls.push({ method: 'where', args: clone(args) }); return query; }, andWhere: (...args) => { calls.push({ method: 'andWhere', args: clone(args) }); return query; }, getMany: async () => [{ id: 'expired-role' }] };
		const clean = Object.assign(new Clean(), {
			config: { deactivateAntennaThreshold: threshold },
			logger: { info: text => calls.push({ method: 'info', text }), succ: text => calls.push({ method: 'succ', text }) },
			userIpsRepository: { delete: async criteria => calls.push({ repository: 'userIps', method: 'delete', criteria: clone(criteria) }) },
			antennasRepository: { update: async (...args) => calls.push({ repository: 'antennas', method: 'update', args: clone(args) }) },
			roleAssignmentsRepository: { createQueryBuilder: () => query, delete: async criteria => calls.push({ repository: 'roleAssignments', method: 'delete', criteria: clone(criteria) }) },
			reversiService: { cleanOutdatedGames: () => calls.push({ method: 'cleanOutdatedGames' }) },
		});
		await clean.process();
		observe(`system-clean-data-threshold-${threshold}`, 'system-clean-process-method', { now, deactivateAntennaThreshold: threshold, expiredRoles: ['expired-role'] }, { calls, queueCleanCalls: 0 });
	}
	// Confirm allSettled completes before any actual QueueModule.dispose closes a handle.
	calls.length = 0;
	let release;
	pendingDrain = new Promise(resolve => { release = resolve; });
	const queueModule = new QueueModule(...queues());
	const closing = queueModule.dispose();
	await Promise.resolve();
	const beforeDrain = clone(calls);
	release();
	await closing;
	assert.equal(beforeDrain.length, 0);
	assert.equal(calls.length, 10);
	observe('queue-dispose-after-pending-drain', 'queue-module-dispose', { heldAllSettled: true }, { beforeDrain, afterDrain: calls });

	// Whole pinned source scan: only QueueService.queueClear invokes a BullMQ-shaped queue.clean.
	const files = execFileSync('git', ['-C', upstream, 'ls-tree', '-r', '--name-only', fixedCommit, '--', prefix], { encoding: 'utf8' }).trim().split('\n').filter(file => file.endsWith('.ts'));
	const scan = { defaultJobOptions: [], retentionSites: [], queueCleanSites: [] };
	for (const file of files) {
		const text = execFileSync('git', ['-C', upstream, 'show', `${fixedCommit}:${file}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
		for (const [index, line] of text.split('\n').entries()) {
			if (/defaultJobOptions/.test(line)) scan.defaultJobOptions.push({ file, line: index + 1 });
			if (/removeOnComplete\s*:/.test(line)) scan.retentionSites.push({ file, line: index + 1 });
			if (/\bqueue\.clean\(/.test(line)) scan.queueCleanSites.push({ file, line: index + 1 });
		}
	}
	assert.equal(scan.defaultJobOptions.length, 0);
	assert.equal(scan.queueCleanSites.length, 8);
	observe('source-retention-and-clean-site-scan', 'pinned-source-text-scan', { files: files.length, excludes: 'non-TS sources, dependencies; queue.clean matches exact receiver name, manual source review required for other receivers' }, scan);
	const upstreamPackage = JSON.parse(source('packages/backend/package.json'));
	assert.equal(upstreamPackage.dependencies.bullmq, '6.3.11');
	assert.equal(new Set(observations.map(item => item.id)).size, observations.length);
	const fixture = { formatVersion: 1, fixedCommit, evidence: 'Pinned source module/AST execution with explicit Queue, scheduler, repository, clock, digest, UUID, decorator, backoff-function, pending-drain doubles. Worker options and lifecycle methods execute separately; no actual processor, Redis, BullMQ cleanup algorithm, Nest DI, HTTP or socket execution.', dependencyVersions: { typescript: ts.version, upstreamBullmq: upstreamPackage.dependencies.bullmq }, sources, queueTypes, observations };
	const expected = path.join(__dirname, 'observations.json');
	if (process.argv.includes('--check')) {
		assert.deepEqual(fixture, JSON.parse(fs.readFileSync(expected, 'utf8')));
		console.log(JSON.stringify({ checked: expected, cases: observations.length, sources: Object.keys(sources).length, producers: producerCases.length }));
	} else {
		const output = process.env.OUTPUT || path.join(os.tmpdir(), 'tiramiss-queue-retention-observations.actual.json');
		fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
		console.log(JSON.stringify({ output, cases: observations.length, sources: Object.keys(sources).length, producers: producerCases.length }));
	}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
