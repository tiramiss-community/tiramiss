import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const root = process.env.UPSTREAM_ROOT;
assert(root, 'Set UPSTREAM_ROOT to the fixed upstream checkout');
const commit = '8e07cf085adf7009583d234a208e30436f020e26';
execFileSync('git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`]);
const require = createRequire(`${root}/package.json`);
const ts = require('typescript');
const files = {
  selector: 'packages/backend/src/core/UserWebhookService.ts',
  producer: 'packages/backend/src/core/QueueService.ts',
  processor: 'packages/backend/src/queue/processors/UserWebhookDeliverProcessorService.ts',
  status: 'packages/backend/src/misc/status-error.ts',
  worker: 'packages/backend/src/queue/QueueProcessorService.ts',
};
function source(key) { return ts.createSourceFile(files[key], execFileSync('git', ['-C', root, 'show', `${commit}:${files[key]}`], { encoding: 'utf8' }), ts.ScriptTarget.Latest, true); }
function literalMethod(key, name, parameters, globals = {}) {
  const klass = source(key).statements.find(ts.isClassDeclaration);
  const method = klass.members.find(m => m.name?.getText() === name);
  assert(method?.body, `literal ${name} must exist`);
  const code = ts.transpile(`(async function(${parameters}) ${method.body.getText()})`, { target: ts.ScriptTarget.ES2022 });
  return vm.runInNewContext(code, { ...globals });
}
const statusCode = ts.transpile(source('status').getText().replace('export class', 'class') + '\nStatusError;', { target: ts.ScriptTarget.ES2022 });
const StatusError = vm.runInNewContext(statusCode);
class UnrecoverableError extends Error {}
const enqueue = literalMethod('selector', 'enqueueUserWebhook', 'userId,type,content');
const getActive = literalMethod('selector', 'getActiveWebhooks', '');
const onMessage = literalMethod('selector', 'onMessage', '_,data');
const produce = literalMethod('producer', 'userWebhookDeliver', 'webhook,type,content,opts', { randomUUID });
const processJob = literalMethod('processor', 'process', 'job', { StatusError, Bull: { UnrecoverableError }, Error });
let database = [{ id: 'hook', userId: 'owner', url: 'https://old.invalid/hook', secret: '', active: true, on: ['note'], latestSentAt: null }];
let reads = 0;
const jobs = [];
const producer = { userWebhookDeliverQueue: { add: async (name, data, opts) => {
  const job = JSON.parse(JSON.stringify({ name, data, opts }));
  jobs.push(job);
  return job;
} } };
const selector = {
  activeWebhooksFetched: false,
  activeWebhooks: [],
  webhooksRepository: { findBy: async where => { assert.equal(where.active, true); reads++; return structuredClone(database.filter(x => x.active)); } },
  queueService: { userWebhookDeliver: (...args) => produce.apply(producer, args) },
  getActiveWebhooks: () => getActive.call(selector),
};
await enqueue.call(selector, 'owner', 'note', { note: { id: 'saved', text: 'first', reactionAndUserPairCache: [] } });
assert.equal(jobs.length, 1);
database[0].active = false;
await enqueue.call(selector, 'owner', 'note', { note: { id: 'stale' } });
assert.equal(jobs.length, 2);
assert.equal(reads, 1);
await onMessage.call(selector, 'ignored transport channel', JSON.stringify({ channel: 'internal', message: { type: 'webhookUpdated', body: database[0] } }));
await enqueue.call(selector, 'owner', 'note', { note: { id: 'disabled' } });
assert.equal(jobs.length, 2);
const enabled = { ...database[0], active: true, url: 'https://new.invalid/hook', secret: 'fixture-secret' };
await onMessage.call(selector, '', JSON.stringify({ channel: 'internal', message: { type: 'webhookUpdated', body: enabled } }));
await enqueue.call(selector, 'owner', 'note', { note: { id: 'updated' } });
assert.equal(jobs[2].data.to, enabled.url);
await onMessage.call(selector, '', JSON.stringify({ channel: 'internal', message: { type: 'webhookDeleted', body: enabled } }));
assert.equal(selector.activeWebhooks.length, 0);

const statuses = [];
const sent = [];
let outcome = { status: 204 };
const processor = {
  logger: { debug: () => {} },
  config: { host: 'source.invalid:444', url: 'https://source.invalid:444' },
  httpRequestService: { send: async (url, args) => { sent.push({ url, ...args }); if (outcome instanceof Error || outcome instanceof StatusError) throw outcome; return outcome; } },
  webhooksRepository: { update: (criteria, patch) => { statuses.push({ criteria, patch }); return new Promise(() => {}); } },
};
// No current DB row or active state: already queued delivery must still use its old snapshot.
assert.equal(await processJob.call(processor, { data: jobs[0].data }), 'Success');
assert.equal(sent[0].url, 'https://old.invalid/hook');
assert.equal(sent[0].headers['X-Misskey-Hook-Secret'], '');
assert.deepEqual(JSON.parse(sent[0].body), {
  server: processor.config.url, hookId: 'hook', userId: 'owner', eventId: jobs[0].data.eventId,
  createdAt: jobs[0].data.createdAt, type: 'note', body: jobs[0].data.content,
});
const failureResults = [];
for (const status of [400, 408, 429, 500]) {
  outcome = new StatusError('fixture', status, 'Fixture');
  const error = await processJob.call(processor, { data: jobs[0].data }).then(() => null, e => e);
  failureResults.push({ status, unrecoverable: error instanceof UnrecoverableError });
  assert.equal(error instanceof UnrecoverableError, status === 400 || status === 408);
  assert.equal(statuses.at(-1).patch.latestStatus, status);
}
outcome = new Error('network fixture');
assert.equal(await processJob.call(processor, { data: jobs[0].data }).catch(e => e), outcome);
assert.equal(statuses.at(-1).patch.latestStatus, 1);
// This final input is outside the valid entity/API contract; records raw method behavior only.
outcome = { status: 200 };
await processJob.call(processor, { data: { ...jobs[0].data, secret: null } });
assert.equal(sent.at(-1).headers['X-Misskey-Hook-Secret'], null);
const fn = source('worker').statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'httpRelatedBackoff');
function backoff(random) { return vm.runInNewContext(ts.transpile(fn.getText() + '\nhttpRelatedBackoff;', { target: ts.ScriptTarget.ES2022 }), { Math: { ...Math, pow: Math.pow, min: Math.min, round: Math.round, random: () => random } }); }
assert.equal(backoff(0)(1), 60000);
assert.equal(backoff(0)(2), 180000);
assert.equal(backoff(0)(3), 420000);
assert.equal(backoff(1)(20), 34560000); // cap is applied BEFORE 20% jitter.
console.log(JSON.stringify({
  result: 'PASS', methodExtraction: 'literal source bodies; repository/queue/HTTP doubles',
  cache: { reads, enqueued: jobs.length, invalidation: 'internal update/delete' },
  delivery: { emptySecret: true, snapshotSurvivesDisableAndDelete: true, statusUpdateIsNotAwaited: true, invalidNullPassedThroughAtRawMethod: true },
  failures: failureResults, retry: { attempts: jobs[0].opts.attempts, backoffFirstThreeMinimumMs: [60000, 180000, 420000], cappedMaximumMs: 34560000 },
  retention: { completed: jobs[0].opts.removeOnComplete, failed: jobs[0].opts.removeOnFail },
}, null, 2));
