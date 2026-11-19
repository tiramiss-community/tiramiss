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
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const path = 'packages/backend/src/server/api/ApiCallService.ts';
const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: new URL('../../../../', import.meta.url) });
const sf = ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
const members = sf.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'ApiCallService').members;
const method = name => members.find(node => node.name?.getText(sf) === name);
const body = method('logIp').body.getText(sf);
const constructor = members.find(ts.isConstructorDeclaration);
const timer = constructor.body.statements.find(node => node.getText(sf).startsWith('this.userIpHistoriesClearIntervalId ='));
assert(timer, 'literal hourly timer');
const shutdown = method('onApplicationShutdown');
assert(shutdown, 'literal shutdown hook');
let tick;
let interval;
let cleared = 0;
const globals = {
	Date: class extends Date { constructor() { super(0); } },
	setInterval(callback, ms) { tick = callback; interval = ms; return 123; },
	clearInterval(id) { assert.equal(id, 123); cleared++; },
};
const evaluate = text => vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), globals);
const log = evaluate(`(function(request, user) ${body})`);
const start = evaluate(`(function() { ${timer.getText(sf)} })`);
const dispose = evaluate(`(function() ${method('dispose').body.getText(sf)})`);
const stop = evaluate(`(function() ${shutdown.body.getText(sf)})`);
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const configPath = 'packages/backend/src/config.ts';
const configBytes = execFileSync('git', ['show', `${pin}:${configPath}`], { cwd: new URL('../../../../', import.meta.url) });
const configAst = ts.createSourceFile(configPath, configBytes.toString(), ts.ScriptTarget.Latest, true);
let trustedProxies;
function visit(node) {
	if (ts.isPropertyAssignment(node) && node.name.getText(configAst) === 'trustProxy') {
		trustedProxies = evaluate(`(${node.initializer.right.getText(configAst)})`);
	}
	ts.forEachChild(node, visit);
}
visit(configAst);
assert(trustedProxies, 'fixed config proxy defaults');
const cases = [];
for (const item of corpus.cases) {
	let attempts = 0;
	let rejected = 0;
	const rows = [];
	let value;
	const query = {
		insert() { return this; }, values(row) { value = row; return this; }, orIgnore(yes) { assert.equal(yes, true); return this; },
		execute() {
			attempts++;
			if (item.failure === 'sync') { throw Error('write'); }
			if (item.failure === 'async') {
				// Observe the rejected write without creating an unhandled rejection in this acquisition process.
				const work = Promise.reject(Error('write'));
				void work.catch(() => { rejected++; });
				return work;
			}
			if (!rows.some(row => row.userId === value.userId && row.ip === value.ip)) { rows.push(value); }
			return Promise.resolve();
		},
	};
	const instance = { dispose, meta: { enableIpLogging: item.enabled }, userIpHistories: new Map(), userIpsRepository: { createQueryBuilder: () => query } };
	start.call(instance);
	for (const [index, [userId, ip]] of item.calls.entries()) {
		if (index === item.clearBefore) { tick(); }
		// handleRequest guards logIp with `if (user)`.
		if (userId !== null) { log.call(instance, { ip }, { id: userId }); }
	}
	await Promise.resolve();
	stop.call(instance);
	cases.push({ id: item.id, attempts, rejected, rows });
}
const sha = value => createHash('sha256').update(value).digest('hex');
const output = JSON.stringify({ upstreamCommit: pin, source: { path, sha256: sha(bytes) }, corpusSha256: sha(corpusBytes), probeSha256: sha(readFileSync(new URL('./source-probe.mjs', import.meta.url))), configSource: { path: configPath, sha256: sha(configBytes) }, trustedProxies, intervalMs: interval, clearedTimers: cleared, observationKind: 'literal logIp, constructor timer statement and shutdown body; repository doubles, fixed clock; async rejection observed at repository boundary', cases }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') { writeFileSync(target, output); }
else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`API IP log fixed source ${cases.length} cases ${process.argv[2]} PASS`);
