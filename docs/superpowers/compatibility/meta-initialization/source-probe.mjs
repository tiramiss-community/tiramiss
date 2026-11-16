/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const revision = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.BACKEND_NEXT_UPSTREAM_PATH;
assert(root, 'Set BACKEND_NEXT_UPSTREAM_PATH to pinned upstream Git objects');
const ts = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url))('typescript');
const sources = {};
function parse(path) {
	const source = execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8' });
	sources[path] = createHash('sha256').update(source).digest('hex');
	return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}
const global = parse('packages/backend/src/GlobalModule.ts');
const service = parse('packages/backend/src/core/MetaService.ts');
const provider = global.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations]).find(n => n.name.getText(global) === '$meta');
const factory = provider.initializer.properties.find(n => n.name?.getText(global) === 'useFactory').initializer;
const observations = [];
let settleTracked;
let releases = [];
const sandbox = {
	MiMeta: class {},
	allSettled: () => new Promise(resolve => { settleTracked = resolve; }),
};
function execute(text) {
	return vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), sandbox);
}
const initialize = execute(`(${factory.getText(global)})`);
function repository(initial, failure = false) {
	const rows = structuredClone(initial);
	let listener;
	let transactions = 0;
	const db = { transaction: async work => {
		transactions++;
		return work({
			find: async (_, options) => {
				assert.equal(options.order.id, 'DESC');
				if (failure) throw new Error('initialization failed');
				return structuredClone(rows).sort((a, b) => b.id.localeCompare(a.id));
			},
			upsert: async (_, row, keys) => {
				assert.equal(JSON.stringify(keys), '["id"]');
				if (!rows.some(existing => existing.id === row.id)) rows.push({ ...row });
				return { identifiers: [{ id: row.id }] };
			},
			findOneByOrFail: async (_, criteria) => structuredClone(rows.find(row => row.id === criteria.id)),
			update: async (_, id, data) => Object.assign(rows.find(row => row.id === id), data),
		});
	} };
	const subscriber = { on: (event, callback) => {
		assert.equal(event, 'message'); listener = callback;
	} };
	return { db, subscriber, rows, initialize: () => initialize(db, subscriber), listener: () => listener, transactions: () => transactions };
}

const empty = repository([]);
assert.equal((await empty.initialize()).id, 'x');
observations.push({ id: 'empty', rows: empty.rows, transactions: empty.transactions() });
const concurrent = repository([]);
assert.deepEqual((await Promise.all(Array.from({ length: 8 }, () => concurrent.initialize()))).map(row => row.id), Array(8).fill('x'));
assert.equal(concurrent.rows.length, 1);
observations.push({ id: 'concurrent', rows: concurrent.rows, transactions: concurrent.transactions() });
const saved = { id: 'x', name: 'kept', blockedHosts: ['kept.example'] };
const existing = repository([saved]);
assert.deepEqual(await existing.initialize(), saved);
observations.push({ id: 'existing-preserved', rows: existing.rows });
const multiple = repository([{ id: 'a', name: 'old' }, { id: 'z', name: 'new' }, saved]);
assert.equal((await multiple.initialize()).id, 'z');
observations.push({ id: 'descending-id', selected: 'z', rowCount: multiple.rows.length });
const failed = repository([], true);
await assert.rejects(failed.initialize(), /initialization failed/);
assert.equal(failed.listener(), undefined);
observations.push({ id: 'initialization-failure', rejected: true, subscribed: false, rows: failed.rows });
const meta = await existing.initialize();
await existing.listener()('host.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { after: { name: 'updated', rootUser: { id: 'joined' } } } } }));
assert.equal(meta.name, 'updated'); assert.equal(meta.rootUser, null);
observations.push({ id: 'global-notification', meta });
const updateNode = service.statements.find(ts.isClassDeclaration).members.find(n => n.name?.getText(service) === 'update');
const update = execute(`(async function(${updateNode.parameters.map(n => n.getText(service)).join(',')}) ${updateNode.body.getText(service)})`);
const updated = repository([saved]);
const events = [];
const after = await update.call({ db: updated.db, globalEventService: { publishInternalEvent: (type, body) => events.push(JSON.parse(JSON.stringify({ type, body }))) } }, { name: 'management-update' });
assert.equal(after.name, 'management-update');
assert.equal(events[0].type, 'metaUpdated');
assert.equal(events[0].body.before.name, 'kept');
assert.equal(events[0].body.after.name, 'management-update');
observations.push({ id: 'management-update-producer', rows: updated.rows, events });
const disposeNode = global.statements.find(ts.isClassDeclaration).members.find(n => n.name?.getText(global) === 'dispose');
const dispose = execute(`(async function() ${disposeNode.body.getText(global)})`);
const disposable = { db: { destroy: () => releases.push('database') } };
for (const name of ['redisClient', 'redisForPub', 'redisForSub', 'redisForTimelines', 'redisForReactions']) disposable[name] = { disconnect: () => releases.push(name) };
const closing = dispose.call(disposable);
assert.deepEqual(releases, []);
settleTracked(); await closing;
assert.equal(releases.length, 6);
observations.push({ id: 'global-dispose', waitsForTracked: true, releases });

const result = { upstreamRevision: revision, sources, method: 'literal GlobalModule $meta factory/dispose and MetaService.update with repository/transaction/pubsub/tracker doubles; no upstream full server or PostgreSQL', observations };
const output = new URL('./observations.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
else assert.deepEqual(result, JSON.parse(readFileSync(output, 'utf8')));
console.log(`PASS: ${observations.length} pinned Meta initialization/update/dispose observations`);
