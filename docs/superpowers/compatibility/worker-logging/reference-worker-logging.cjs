/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

const commit = '8e07cf085adf7009583d234a208e30436f020e26';
const upstream = process.env.UPSTREAM_ROOT || process.argv[2];
assert(upstream, 'Pass a Git checkout containing the pinned upstream commit');
const repository = path.resolve(__dirname, '../../../..');
const ts = createRequire(path.join(repository, 'package.json'))('typescript');
const file = 'packages/backend/src/queue/QueueProcessorService.ts';
const source = execFileSync('git', ['-C', upstream, 'show', `${commit}:${file}`], { encoding: 'utf8' });
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'QueueProcessorService');
const constructor = cls.members.find(ts.isConstructorDeclaration);
const helpers = constructor.body.statements.filter(node => ts.isFunctionDeclaration(node)).map(node => node.getText(tree)).join('\n');
const jobInfo = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'getJobInfo').getText(tree);
const regions = ['deliver', 'user-webhook deliver', 'ended poll notification'].map(region => {
	const start = source.indexOf(`//#region ${region}\n`);
	assert(start > 0, region);
	return source.slice(start, source.indexOf('//#endregion', start));
}).join('\n');
const runnerFile = 'packages/backend/src/queue/queue-job-runner.ts';
const runner = execFileSync('git', ['-C', upstream, 'show', `${commit}:${runnerFile}`], { encoding: 'utf8' });
const workers = new Map();
const logs = [];
const now = 100000;
class Clock extends Date { static now() { return now; } }
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
class Worker extends EventEmitter {
	constructor(name, processor) { super(); this.processor = processor; workers.set(name, this); }
}
const context = { Error, Date: Clock, module: { exports: {} }, exports: {}, Bull: { Worker, UnrecoverableError: class extends Error {} },
	QUEUE: { DELIVER: 'deliver', USER_WEBHOOK_DELIVER: 'userWebhookDeliver', ENDED_POLL_NOTIFICATION: 'endedPollNotification' },
	baseWorkerOptions: () => ({}), httpRelatedBackoff: () => 0,
};
context.exports = context.module.exports;
const run = ts.transpileModule(runner, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(run, context);
context.runQueueJob = context.module.exports.runQueueJob;
const setup = ts.transpileModule(`function setup() { ${helpers}\n${regions} }\n${jobInfo}\nglobalThis.setup = setup;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(setup, context);
const sink = domain => Object.fromEntries(['debug', 'warn', 'error'].map(level => [level, (message, fields) => logs.push({ domain, level, message, fields: clone(fields) })]));
const failure = new Error('controlled retry');
failure.stack = 'controlled-stack';
const service = { config: {}, logger: { createSubLogger: sink }, telemetryService: { startSpan: (_name, fn) => fn(), captureMessage() {} },
	deliverProcessorService: { process: async () => { throw failure; } },
	userWebhookDeliverProcessorService: { process: async () => { throw failure; } },
	endedPollNotificationProcessorService: { process: async () => { throw failure; } },
};
context.setup.call(service);
(async () => {
	const observations = [];
	for (const [queue, worker] of workers) {
		const registeredEvents = worker.eventNames().map(String);
		const job = { id: '7', name: 'fixture-job', attemptsMade: 2, opts: { attempts: 4 }, timestamp: 98000, data: { to: 'https://remote.test/inbox', noteId: 'note' } };
		const start = logs.length;
		worker.emit('active', job);
		worker.emit('completed', job, 'Success');
		if (registeredEvents.includes('error')) { worker.emit('error', failure); }
		worker.emit('stalled', '7');
		await assert.rejects(worker.processor(job), error => error === failure);
		observations.push({ queue, registeredEvents, logs: logs.slice(start) });
	}
	process.stdout.write(`${JSON.stringify({ commit, sources: Object.fromEntries([[file, source], [runnerFile, runner]].map(([name, text]) => [name, { sha256: createHash('sha256').update(text).digest('hex') }])), now, observations }, null, 2)}\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
