/*
 * SPDX-FileCopyrightText: 2026 tiramiss-community
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Pinned-source execution with explicit doubles; this is not a full upstream server.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const fixedCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const upstream = process.env.UPSTREAM_ROOT || process.argv[2];
assert(upstream, 'Pass the upstream Git checkout or set UPSTREAM_ROOT');
const repository = process.env.REPOSITORY_ROOT || path.resolve(__dirname, '../../../..');
const requireRoot = createRequire(path.join(repository, 'package.json'));
const ts = requireRoot('typescript');
const requireBackend = createRequire(path.join(repository, 'packages/backend/package.json'));
const requireAjv = fs.existsSync(path.join(repository, 'packages/backend/node_modules/ajv/package.json')) ? requireBackend : createRequire(path.join(repository, 'node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/package.json'));
const sources = {};
const texts = new Map();
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const observations = [];
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
function classMembers(file, name, wanted) {
	const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
	const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
	assert(cls, name);
	const found = cls.members.filter(node => wanted.includes(node.name?.getText(tree)));
	assert.equal(found.length, wanted.length);
	return found.map(node => node.getText(tree)).join('\n');
}
function createRuntime() {
	const cache = new Map();
	const eventBus = new EventEmitter();
	const timers = new Map();
	const queueEvents = [];
	const timerCalls = [];
	let nextTimer = 0;
	class Xev { constructor() { return eventBus; } }
	class QueueEvents extends EventEmitter {
		constructor(name, options) { super(); this.name = name; this.options = options; queueEvents.push(this); }
		close() { throw new Error('Unexpected QueueEvents.close call: pinned source does not close it'); }
	}
	const noopDecorator = () => () => {};
	const stubs = {
		'@nestjs/common': { Inject: noopDecorator, Injectable: noopDecorator, Scope: { TRANSIENT: 'transient' } },
		'@nestjs/core': { REQUEST: 'request' },
		'xev': { __esModule: true, default: Xev },
		'bullmq': { MetricsTime: { ONE_WEEK: 10080 }, QueueEvents },
		'@/di-symbols.js': { DI: {} },
		'@/core/activitypub/ApRequestService.js': { ApRequestCreator: {} },
		'@/misc/get-ip-hash.js': { getIpHash: () => 'ip-hash' },
		'@/misc/create-temp.js': { createTemp: () => { throw new Error('Multipart outside oracle scope'); } },
		'@/misc/is-instance-muted.js': { isInstanceMuted: () => false },
		'@/misc/is-user-related.js': { isUserRelated: () => false },
		'@/misc/is-renote.js': { isQuotePacked: () => false, isRenotePacked: () => false },
		'@/misc/is-channel-related.js': { isChannelRelated: () => false },
	};
	const globals = {
		console, Date, Map, Set, Promise, Object, Reflect, URL,
		setInterval(callback, milliseconds) { const id = ++nextTimer; timers.set(id, callback); timerCalls.push(['setInterval', milliseconds]); return id; },
		clearInterval(id) { timers.delete(id); timerCalls.push(['clearInterval']); },
	};
	function compile(text, filename, extra = {}) {
		const module = { exports: {} };
		const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, emitDecoratorMetadata: false } }).outputText;
		vm.runInNewContext(output, { ...globals, ...extra, module, exports: module.exports, require: specifier => {
			if (specifier === 'node:crypto') return { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
			if (specifier.startsWith('node:')) return require(specifier);
			if (specifier === 'ajv') return requireAjv('ajv');
			if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
			const resolved = specifier.startsWith('@/') ? `packages/backend/src/${specifier.slice(2)}` : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier)) : null;
			assert(resolved, `Unrecognized runtime dependency ${specifier} from ${filename}`);
			return load(resolved.replace(/\.js$/, '.ts'));
		} }, { filename });
		return module.exports;
	}
	function load(file) {
		if (!cache.has(file)) {
			let text = source(file);
			// The actual authentication error class is sufficient; authentication itself is an explicit double.
			if (file.endsWith('/AuthenticateService.ts')) {
				const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
				text = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AuthenticationError').getText(tree);
			}
			cache.set(file, compile(text, file));
		}
		return cache.get(file);
	}
	return { load, compile, eventBus, timers, queueEvents, timerCalls };
}
const prefix = 'packages/backend/src/';
const runtime = createRuntime();
const { QueueService, QUEUE_TYPES } = runtime.load(`${prefix}core/QueueService.ts`);
const registration = source(`${prefix}server/api/endpoint-list.ts`);
const routes = [...registration.matchAll(/export \* as '(admin\/queue\/[^']+)' from '([^']+)';/g)].map(match => ({ name: match[1], file: `${prefix}server/api/${match[2].slice(2).replace(/\.js$/, '.ts')}` }));
assert.equal(routes.length, 14);
assert.equal(new Set(routes.map(route => route.name)).size, 14);
assert.deepEqual(routes.map(route => route.name.split('/').at(-1)).sort(), ['clear', 'deliver-delayed', 'inbox-delayed', 'jobs', 'pause', 'promote-jobs', 'queue-stats', 'queues', 'remove-job', 'resume', 'retry-job', 'show-job', 'show-job-logs', 'stats']);
const endpointModules = new Map(routes.map(route => [route.name, runtime.load(route.file)]));
const { ApiCallService } = runtime.load(`${prefix}server/api/ApiCallService.ts`);
const { AuthenticationError } = runtime.load(`${prefix}server/api/AuthenticateService.ts`);
const { ModerationLogService } = runtime.load(`${prefix}core/ModerationLogService.ts`);
source(`${prefix}models/json-schema/queue.ts`);
const metadata = routes.map(route => ({ name: route.name, ...clone({ meta: endpointModules.get(route.name).meta, paramDef: endpointModules.get(route.name).paramDef }) }));
assert(metadata.every(route => route.meta.requireCredential && route.meta.requireModerator && !route.meta.limit));
const defaultData = { content: 'body-visible', to: 'https://remote.example/inbox', signature: { keyId: 'https://signer.example/key' }, secret: 'fixture-secret', userId: 'recipient-visible' };
function createContext(options = {}) {
	const calls = [];
	const service = Object.create(QueueService.prototype);
	const jobs = options.jobs || [{ id: 'job', name: 'test job', data: defaultData, finishedOn: 1000 }];
	const record = (queue, method, args) => calls.push({ queue, method, args: clone(args) });
	const counts = { active: 1, waiting: 2, delayed: 3, completed: 4, failed: 5, paused: 0, prioritized: 0, 'waiting-children': 0 };
	const metric = { meta: { count: 4, prevTS: 1000, prevCount: 3 }, data: [1, 2], count: 2 };
	let release;
	const held = new Promise(resolve => { release = resolve; });
	const info = '# Server\nredis_version:7.2.0\nredis_mode:standalone\nrun_id:fixture-run\nprocess_id:123\ntcp_port:6379\nos:Linux\nuptime_in_seconds:10\ntotal_system_memory:0\nmaxmemory:1234\nused_memory:200\nmem_fragmentation_ratio:1.75\nused_memory_peak:300\nconnected_clients:4\nblocked_clients:1\n';
	function operation(queue, method, args, result) {
		record(queue, method, args);
		if (options.fail === method) return Promise.reject(new Error(`fixture ${method} failed`));
		if (options.hold === method) return held.then(() => result);
		return Promise.resolve(result);
	}
	function job(queue, data) {
		return { timestamp: 100, processedOn: 200, processedBy: 'worker', progress: 0, attemptsMade: 2, delay: 10, stacktrace: ['older', '', null, 'newer'], opts: { attempts: 12 }, returnvalue: { result: true }, ...data,
			retry: () => operation(queue, 'retry', [data.id]), promote: () => operation(queue, 'promote', [data.id]), remove: () => operation(queue, 'remove', [data.id]),
		};
	}
	for (const type of QUEUE_TYPES) {
		const packedJobs = jobs.map(data => job(type, data));
		service[`${type}Queue`] = {
			qualifiedName: `fixture:queue:${type}:${type}`,
			getJob: id => operation(type, 'getJob', [id], packedJobs.find(item => item.id === id)),
			getJobs: (types, start = 0, end = -1) => operation(type, 'getJobs', [types, start, end], packedJobs.slice(start, end < 0 ? undefined : end + 1)),
			getJobLogs: id => operation(type, 'getJobLogs', [id], { logs: options.logs || ['log: fixture-secret'], count: 1 }),
			getJobCounts: () => operation(type, 'getJobCounts', [], options.counts || counts),
			isPaused: () => operation(type, 'isPaused', [], false),
			getMetrics: (...args) => operation(type, 'getMetrics', args, metric),
			getBackend: () => ({ client: Promise.resolve({ info: () => operation(type, 'info', [], info) }) }),
			clean: (...args) => operation(type, 'clean', args, []),
			promoteJobs: () => operation(type, 'promoteJobs', []),
			pause: () => operation(type, 'pause', []), resume: () => operation(type, 'resume', []),
		};
	}
	const moderation = new ModerationLogService({ insert: value => { calls.push({ method: 'moderation.insert', value: clone(value) }); return options.fail === 'audit' ? Promise.reject(new Error('fixture audit failed')) : Promise.resolve(); } }, { gen: () => 'audit-id' });
	return { service, moderation, calls, release };
}
function endpoint(name, context) {
	const route = routes.find(item => item.name === name);
	const module = endpointModules.get(name);
	const tree = ts.createSourceFile(route.file, source(route.file), ts.ScriptTarget.Latest, true);
	const cls = tree.statements.find(ts.isClassDeclaration);
	const constructor = cls.members.find(ts.isConstructorDeclaration);
	const deps = constructor.parameters.map(parameter => {
		const key = parameter.name.getText(tree);
		if (key === 'queueService') return context.service;
		if (key === 'moderationLogService') return context.moderation;
		assert(Object.hasOwn(context.service, key), `Unknown endpoint dependency ${key}`);
		return context.service[key];
	});
	const instance = new module.default(...deps);
	return { name, meta: module.meta, params: module.paramDef, exec: instance.exec };
}
async function httpObservation(id, suffix, params, actor = 'moderator', options = {}) {
	const context = createContext(options);
	const user = actor === 'anonymous' ? null : { id: actor.startsWith('root') ? 'root' : 'actor', isSuspended: actor.endsWith('suspended') };
	const token = actor === 'wrong-scope' ? { permission: [] } : actor === 'read-only-scope' ? { permission: ['read:admin:queue'] } : actor === 'scoped' ? { permission: ['read:admin:queue', 'write:admin:queue'] } : null;
	const roles = ['member', 'root', 'root-suspended'].includes(actor) ? [] : [{ isModerator: actor !== 'administrator', isAdministrator: actor === 'administrator' }];
	const telemetry = { startSpan: (_name, callback) => callback(), captureMessage() {} };
	const api = new ApiCallService({ rootUserId: 'root', enableIpLogging: false }, {}, {}, { authenticate: async () => {
		if (actor === 'invalid-token') throw new AuthenticationError('invalid');
		return [user, token];
	} }, { limit: () => { throw new Error('Queue endpoints have no rate limiter'); } }, {
		getUserRoles: async () => roles,
		getUserPolicies: async () => { throw new Error('Queue endpoints have no rate policy lookup'); },
	}, { logger: { write() {}, warn() {} } }, telemetry);
	const response = { status: 200, headers: {}, body: null };
	const reply = { code(status) { response.status = status; return this; }, header(name, value) { response.headers[name] = value; return this; }, send(body) { response.body = clone(body); return this; } };
	const unhandled = [];
	const capture = error => unhandled.push(error.message);
	process.on('unhandledRejection', capture);
	try {
		await api.handleRequest(endpoint(`admin/queue/${suffix}`, context), { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: clone(params), ip: '192.0.2.1' }, reply);
		const callsAtResponse = context.calls.length;
		await turn();
		await turn();
		const result = { id, layer: 'http-handler', input: { route: `admin/queue/${suffix}`, params, actor, ...(Object.keys(options).length ? { doubles: options } : {}) }, expected: { response, calls: context.calls, callsAtResponse, detachedRejections: unhandled } };
		observations.push(result);
		return result;
	} finally {
		api.dispose();
		process.off('unhandledRejection', capture);
	}
}

async function runHttp() {
	for (const { name } of routes) {
		const suffix = name.split('/').at(-1);
		const params = ['stats', 'queues', 'deliver-delayed', 'inbox-delayed'].includes(suffix) ? {} : suffix === 'jobs' ? { queue: 'deliver', state: ['wait'] } : suffix === 'clear' ? { queue: 'deliver', state: '*' } : ['show-job', 'show-job-logs', 'retry-job', 'remove-job'].includes(suffix) ? { queue: 'deliver', jobId: 'job' } : { queue: 'deliver' };
		await httpObservation(`route-${suffix}`, suffix, params);
	}
	for (const queue of QUEUE_TYPES) await httpObservation(`selector-${queue}`, 'show-job', { queue, jobId: 'job' });
	for (const actor of ['anonymous', 'member', 'suspended', 'root', 'root-suspended', 'administrator', 'scoped', 'wrong-scope', 'invalid-token']) {
		await httpObservation(`auth-${actor}`, 'pause', { queue: 'deliver' }, actor);
	}
	await httpObservation('auth-read-scope-allowed', 'show-job', { queue: 'deliver', jobId: 'job' }, 'read-only-scope');
	await httpObservation('auth-read-scope-write-denied', 'pause', { queue: 'deliver' }, 'read-only-scope');
	for (const actor of ['anonymous', 'member', 'wrong-scope']) await httpObservation(`auth-before-validation-${actor}`, 'pause', { queue: 'invalid' }, actor);
	for (const [id, suffix, params] of [
		['missing-queue', 'pause', {}], ['unknown-queue', 'pause', { queue: 'other' }], ['wrong-queue-type', 'pause', { queue: 1 }],
		['missing-job', 'show-job', { queue: 'deliver' }], ['wrong-job-type', 'show-job', { queue: 'deliver', jobId: 1 }],
		['missing-state', 'jobs', { queue: 'deliver' }], ['scalar-state', 'jobs', { queue: 'deliver', state: 'wait' }],
		['unsupported-job-state', 'jobs', { queue: 'deliver', state: ['paused'] }], ['unsupported-clear-state', 'clear', { queue: 'deliver', state: 'waiting' }],
		['wrong-search', 'jobs', { queue: 'deliver', state: [], search: 3 }], ['extra-params', 'jobs', { queue: 'deliver', state: [], limit: 1, offset: 99 }],
		['empty-job-id', 'remove-job', { queue: 'deliver', jobId: '' }], ['missing-job-show', 'show-job', { queue: 'deliver', jobId: 'absent' }],
		['missing-job-remove', 'remove-job', { queue: 'deliver', jobId: 'absent' }], ['missing-job-retry', 'retry-job', { queue: 'deliver', jobId: 'absent' }],
		['missing-job-logs', 'show-job-logs', { queue: 'deliver', jobId: 'absent' }],
	]) await httpObservation(id, suffix, params);
	for (const [suffix, fail, params] of [
		['pause', 'pause', { queue: 'deliver' }], ['resume', 'resume', { queue: 'deliver' }],
		['clear', 'clean', { queue: 'deliver', state: 'failed' }], ['promote-jobs', 'promoteJobs', { queue: 'deliver' }],
		['retry-job', 'retry', { queue: 'deliver', jobId: 'job' }], ['remove-job', 'remove', { queue: 'deliver', jobId: 'job' }],
		['pause', 'audit', { queue: 'deliver' }], ['show-job', 'getJob', { queue: 'deliver', jobId: 'job' }],
	]) await httpObservation(`failure-${suffix}-${fail}`, suffix, params, 'moderator', { fail });
	await httpObservation('retry-promotes-unfinished', 'retry-job', { queue: 'deliver', jobId: 'job' }, 'moderator', { jobs: [{ id: 'job', name: 'pending', data: {} }] });
	await httpObservation('empty-stack-not-failed', 'show-job', { queue: 'deliver', jobId: 'job' }, 'moderator', { jobs: [{ id: 'job', name: 'clean', data: {}, stacktrace: ['', null], failedReason: '' }] });
	const delayed = [
		{ id: '1', name: 'a', data: { to: 'https://a.example:8443/x', signature: { keyId: 'https://a.example/key' } } },
		{ id: '2', name: 'b', data: { to: 'https://b.example/x', signature: { keyId: 'https://a.example/key2' } } },
		{ id: '3', name: 'c', data: { to: 'https://b.example/y', signature: { keyId: 'https://b.example/key' } } },
	];
	await httpObservation('delayed-deliver-group-sort', 'deliver-delayed', {}, 'moderator', { jobs: delayed });
	await httpObservation('delayed-inbox-group-sort', 'inbox-delayed', {}, 'moderator', { jobs: delayed });
	await httpObservation('delayed-invalid-url', 'deliver-delayed', {}, 'moderator', { jobs: [{ id: 'bad', data: { to: 'bad url' } }] });
	for (const [suffix, hold, params] of [
		['pause', 'pause', { queue: 'deliver' }], ['resume', 'resume', { queue: 'deliver' }],
		['clear', 'clean', { queue: 'deliver', state: 'failed' }], ['promote-jobs', 'promoteJobs', { queue: 'deliver' }],
		['retry-job', 'retry', { queue: 'deliver', jobId: 'job' }], ['remove-job', 'remove', { queue: 'deliver', jobId: 'job' }],
	]) {
		const context = createContext({ hold });
		let settled = false;
		const pending = endpoint(`admin/queue/${suffix}`, context).exec(params, { id: 'actor' }, null).then(() => { settled = true; });
		await turn();
		const beforeRelease = { settled, calls: clone(context.calls) };
		context.release(); await pending; await turn();
		observations.push({ id: `boundary-${suffix}`, layer: 'endpoint-callback', input: { route: `admin/queue/${suffix}`, params, heldQueueOperation: hold }, expected: { beforeRelease, afterRelease: { settled, calls: context.calls } } });
		assert.equal(beforeRelease.settled, !['pause', 'resume'].includes(suffix));
	}
	const large = Array.from({ length: 1002 }, (_, index) => ({ id: String(index), name: 'Search Target', data: { secret: 'needle-secret' }, stacktrace: [] }));
	// Keep corpus compact: store a deterministic repeated-jobs recipe, while comparing full responses through digests.
	for (const [id, search] of [['jobs-no-search', undefined], ['jobs-empty-search', ''], ['jobs-search-cap', 'search target'], ['jobs-search-secret-redacted', 'needle-secret'], ['jobs-search-metadata', 'attempts']]) {
		const context = createContext({ jobs: large });
		const params = { queue: 'userWebhookDeliver', state: ['wait'], ...(search === undefined ? {} : { search }) };
		const result = await endpoint('admin/queue/jobs', context).exec(params, { id: 'actor' }, null);
		observations.push({ id, layer: 'endpoint-callback', input: { route: 'admin/queue/jobs', params, repeatedJobs: { count: 1002, name: 'Search Target', data: { secret: 'needle-secret' }, stacktrace: [] } }, expected: { count: result.length, first: clone(result[0]), last: clone(result.at(-1)), digest: createHash('sha256').update(JSON.stringify(result)).digest('hex'), calls: context.calls } });
	}
}

async function runStream() {
	const rt = createRuntime();
	const { QueueStatsChannel } = rt.load(`${prefix}server/api/stream/channels/queue-stats.ts`);
	const { QueueStatsService } = rt.load(`${prefix}daemons/QueueStatsService.ts`);
	const bindThis = rt.load(`${prefix}decorators.ts`).bindThis;
	const connectionFile = `${prefix}server/api/stream/Connection.ts`;
	const connectionSource = `export class Connection {${classMembers(connectionFile, 'Connection', ['connectChannel', 'disconnectChannel', 'onChannelMessageRequested', 'dispose'])}}`;
	let request;
	const { Connection } = rt.compile(connectionSource, connectionFile, {
		bindThis, MAX_CHANNELS_PER_CONNECTION: 32, ContextIdFactory: { create: () => 'context' }, WebSocket: { WebSocket: { OPEN: 1 } },
		isJsonObject: rt.load(`${prefix}misc/json-value.ts`).isJsonObject,
	});
	function connection(actor) {
		const messages = [];
		const connection = Object.assign(new Connection(), {
			user: actor === 'anonymous' ? null : { id: 'member' }, token: actor === 'unscoped-app' ? { permission: [] } : null,
			channels: new Map(), subscribingNotes: new Map(), wsConnection: { readyState: 1 },
			getChannelConstructor: name => { assert.equal(name, 'queueStats'); return QueueStatsChannel; },
			moduleRef: { registerRequestByContextId: value => { request = value; }, create: async Constructor => new Constructor(request) },
			sendMessageToWs: (type, body) => messages.push(clone({ type, body })),
		});
		return { connection, messages };
	}
	const variableCounts = { active: 1, waiting: 2, delayed: 3 };
	const context = createContext({ counts: variableCounts });
	const producer = new QueueStatsService({ redisForJobQueue: { prefix: 'fixture', host: 'redis.example', port: 6379 } }, context.service);
	producer.start();
	await turn();
	assert.equal(rt.queueEvents.length, 2);
	for (const actor of ['anonymous', 'member', 'unscoped-app']) {
		const ctx = connection(actor);
		await ctx.connection.connectChannel('channel-id', {}, 'queueStats', true);
		await ctx.connection.connectChannel('duplicate', {}, 'queueStats', true);
		ctx.connection.onChannelMessageRequested({ id: 'channel-id', type: 'requestLog', body: { id: 'request-id', length: 1 } });
		observations.push({ id: `stream-connection-${actor}`, layer: 'stream-connection', input: { actor, upgradeBypassed: true, connect: { id: 'channel-id', channel: 'queueStats', pong: true }, duplicateId: 'duplicate', requestLog: { id: 'request-id', length: 1 } }, expected: { messages: ctx.messages, channelCount: ctx.connection.channels.size } });
		ctx.connection.dispose();
	}
	const ctx = connection('anonymous');
	await ctx.connection.connectChannel('channel-id', {}, 'queueStats');
	for (const body of [null, [], {}, { id: 1, length: 1 }, { id: 'id' }, { id: 'id', length: '1' }]) ctx.connection.onChannelMessageRequested({ id: 'channel-id', type: 'requestLog', body });
	ctx.connection.onChannelMessageRequested({ id: 'channel-id', type: 'unknown', body: { id: 'id', length: 1 } });
	observations.push({ id: 'stream-invalid-log-ignored', layer: 'stream-channel', input: { invalidBodies: [null, [], {}, { id: 1, length: 1 }, { id: 'id' }, { id: 'id', length: '1' }], unknownOperation: 'unknown' }, expected: { messages: clone(ctx.messages) } });
	rt.queueEvents[0].emit('active'); rt.queueEvents[0].emit('active'); rt.queueEvents[1].emit('active');
	const tick = [...rt.timers.values()][0];
	await tick();
	ctx.connection.onChannelMessageRequested({ id: 'channel-id', type: 'requestLog', body: { id: 'id', length: 1 } });
	observations.push({ id: 'stream-active-count-and-log', layer: 'stream-producer-channel', input: { deliverActiveEvents: 2, inboxActiveEvents: 1, ticks: 1, requestLog: { id: 'id', length: 1 } }, expected: { messages: clone(ctx.messages), queueEvents: rt.queueEvents.map(item => ({ name: item.name, options: item.options })), timerCalls: clone(rt.timerCalls) } });
	ctx.messages.length = 0;
	await tick();
	observations.push({ id: 'stream-active-reset', layer: 'stream-producer-channel', input: { ticks: 1 }, expected: { messages: clone(ctx.messages) } });
	for (let index = 0; index < 200; index++) { variableCounts.active = 100 + index; await tick(); }
	ctx.messages.length = 0;
	for (const length of [1000, -1, 1.9, 0]) {
		ctx.connection.onChannelMessageRequested({ id: 'channel-id', type: 'requestLog', body: { id: 'id', length } });
		const message = ctx.messages.pop();
		observations.push({ id: `stream-history-${length}`, layer: 'stream-producer-channel', input: { priorTicks: 203, recent200ActiveCounts: { firstTick: 100, lastTick: 299 }, requestLog: { id: 'id', length } }, expected: { type: message.body.type, count: message.body.body.length, first: clone(message.body.body[0]), last: clone(message.body.body.at(-1)) } });
	}
	ctx.connection.disconnectChannel('channel-id');
	ctx.messages.length = 0;
	await tick();
	observations.push({ id: 'stream-disconnect-unsubscribes', layer: 'stream-connection', input: { disconnectId: 'channel-id', subsequentTicks: 1 }, expected: { messages: ctx.messages, statsListeners: rt.eventBus.listenerCount('queueStats') } });
	producer.dispose();
	observations.push({ id: 'stream-producer-dispose-source-limits', layer: 'stream-producer', input: { operation: 'dispose' }, expected: { timers: rt.timers.size, remainingRequestLogListeners: rt.eventBus.listenerCount('requestQueueStatsLog'), activeEventListeners: rt.queueEvents.map(item => item.listenerCount('active')) } });
	// No producer replies: source dispose does not remove the pending once listener.
	rt.eventBus.removeAllListeners('requestQueueStatsLog');
	const pending = connection('anonymous');
	await pending.connection.connectChannel('pending-channel', {}, 'queueStats');
	pending.connection.onChannelMessageRequested({ id: 'pending-channel', type: 'requestLog', body: { id: 'pending', length: 1 } });
	pending.connection.dispose();
	observations.push({ id: 'stream-pending-log-listener-survives-dispose', layer: 'stream-channel', input: { producerAbsent: true, requestLog: { id: 'pending', length: 1 }, dispose: true }, expected: { pendingLogListeners: rt.eventBus.listenerCount('queueStatsLog:pending'), statsListeners: rt.eventBus.listenerCount('queueStats') } });
	assert.equal(rt.timers.size, 0);
}

async function runUpgrade() {
	const file = `${prefix}server/api/StreamingApiServerService.ts`;
	const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
	const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'StreamingApiServerService');
	const fields = cls.members.filter(ts.isPropertyDeclaration).map(node => node.getText(tree)).join('\n');
	for (const actor of ['anonymous', 'member', 'read-account-app', 'unscoped-app', 'suspended', 'invalid-token']) {
		const rt = createRuntime();
		class WebSocketServer extends EventEmitter {
			handleUpgrade(_request, socket) { socket.upgraded = true; }
			close(callback) { callback(); }
		}
		const { StreamingApiServerService } = rt.compile(`export class StreamingApiServerService {${fields}\n${classMembers(file, 'StreamingApiServerService', ['attach', 'detach'])}}`, file, {
			bindThis: rt.load(`${prefix}decorators.ts`).bindThis, WebSocket: { WebSocketServer }, EventEmitter,
			ContextIdFactory: { create: () => 'context' }, MainStreamConnection: class {}, AuthenticationError,
		});
		const server = new EventEmitter();
		const service = Object.assign(new StreamingApiServerService(), {
			redisForSub: new EventEmitter(), moduleRef: { registerRequestByContextId() {}, create: async () => ({ init: async () => {} }) },
			authenticateService: { authenticate: async () => {
				if (actor === 'invalid-token') throw new AuthenticationError('invalid');
				return [actor === 'anonymous' ? null : { id: 'member', isSuspended: actor === 'suspended' }, actor.endsWith('-app') ? { permission: actor === 'read-account-app' ? ['read:account'] : [] } : null];
			} }, usersService: {},
		});
		service.attach(server);
		const socket = { writes: [], destroyed: false, upgraded: false, write(text) { this.writes.push(text); }, destroy() { this.destroyed = true; } };
		await server.listeners('upgrade')[0]({ url: '/streaming?i=fixture', headers: { host: 'fixture.example' } }, socket, null);
		observations.push({ id: `stream-upgrade-${actor}`, layer: 'stream-upgrade', input: { actor, appPermission: actor === 'read-account-app' ? ['read:account'] : actor === 'unscoped-app' ? [] : null }, expected: { upgraded: socket.upgraded, destroyed: socket.destroyed, writes: socket.writes } });
		assert.equal(socket.upgraded, ['anonymous', 'member', 'read-account-app'].includes(actor));
		await service.detach();
	}
}

(async () => {
	await runHttp();
	await runStream();
	await runUpgrade();
	const byId = id => observations.find(item => item.id === id).expected;
	assert.equal(byId('jobs-no-search').count, 101);
	assert.equal(byId('jobs-search-cap').count, 100);
	assert.equal(byId('jobs-search-secret-redacted').count, 0);
	assert.equal(byId('auth-anonymous').response.status, 401);
	assert.equal(byId('auth-member').response.status, 403);
	assert.equal(byId('missing-queue').response.body.error.info.param, '#/required');
	assert.equal(byId('failure-pause-pause').response.status, 500);
	assert.equal(byId('failure-clear-clean').response.status, 204);
	assert.equal(byId('failure-clear-clean').detachedRejections.length, 1);
	assert.equal(byId('selector-userWebhookDeliver').response.body.data.secret, '(redacted)');
	assert.equal(byId('selector-deliver').response.body.data.secret, 'fixture-secret');
	assert.equal(byId('route-queue-stats').response.body.db.memory.fragmentationRatio, 1);
	assert.equal(byId('stream-history-1000').count, 200);
	assert.equal(byId('stream-history--1').count, 199);
	assert.equal(byId('stream-history-1000').first.deliver.active, 299);
	assert.equal(byId('stream-history-1000').last.deliver.active, 100);
	assert.equal(new Set(observations.map(item => item.id)).size, observations.length);
	const fixture = { formatVersion: 1, fixedCommit, evidence: 'Actual fixed Git source modules and explicitly named Connection AST methods executed with Queue/QueueEvents, authentication/role, clock, Xev and HTTP request/reply doubles. No full upstream server, real Redis, Nest DI, actual authentication or actual socket.', dependencyVersions: { typescript: requireRoot('typescript/package.json').version, ajv: requireAjv('ajv/package.json').version, upstreamBullmq: '6.3.11' }, sources, queueTypes: clone(QUEUE_TYPES), metadata, observations };
	const output = process.env.OUTPUT || path.join(os.tmpdir(), 'tiramiss-queue-admin-observations.actual.json');
	fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
	console.log(JSON.stringify({ output, cases: observations.length, routes: routes.length, queues: QUEUE_TYPES.length, sources: Object.keys(sources).length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
