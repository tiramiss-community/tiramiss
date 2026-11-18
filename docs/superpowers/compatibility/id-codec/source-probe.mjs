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
const { ulid } = require('ulid');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const manifest = [];
function source(path) {
	const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: new URL('../../../../', import.meta.url) });
	manifest.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function run(text, context) {
	return vm.runInContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), context);
}
function declarations(sf) {
	return sf.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(sf).replace(/^export /, '')).join('\n');
}
const bigint = declarations(source('packages/backend/src/misc/bigint.ts'));
const service = source('packages/backend/src/core/IdService.ts');
const methods = service.statements.find(ts.isClassDeclaration).members.filter(ts.isMethodDeclaration);
const literalMethods = methods.map(n => `${n.name.getText(service)}(${n.parameters.map(p => p.getText(service)).join(',')}) ${n.body.getText(service)}`).join('\n');
const now = Date.parse('2026-10-17T12:00:00.123Z');
const inputs = [
	['omitted', null], ['zero', 0], ['negative', -1], ['one', 1], ['second-minus-one', 999], ['second', 1000], ['second-plus-one', 1001],
	['epoch-minus-one', 946684799999], ['epoch', 946684800000], ['epoch-plus-one', 946684800001],
	['now-minus-one', now - 1], ['now', now], ['future', now + 1], ['nan', null],
	['aid-rollover-minus-one', 946684800000 + 36 ** 8 - 1], ['aid-rollover', 946684800000 + 36 ** 8],
	['clock-zero', 0], ['clock-negative', -1], ['meid-rollover', 0x800000000000], ['meidg-rollover', 0x100000000000], ['objectid-rollover', 0x100000000 * 1000], ['ulid-max', 0xffffffffffff], ['ulid-overflow', 0x1000000000000],
];
const cases = [];
const existingIds = [];
for (const [method, file] of [['aid', 'aid', 8], ['aidx', 'aidx', 8], ['meid', 'meid', 12], ['meidg', 'meidg', 12], ['objectid', 'object-id', 8], ['ulid', 'ulid', 10]]) {
	const sf = source(`packages/backend/src/misc/id/${file}.ts`);
	let clock = now;
	const context = vm.createContext({
		crypto: { randomBytes: n => Buffer.alloc(n) }, customAlphabet: (_, n) => () => '0'.repeat(n), ulid: time => {
			const original = Date.now;
			Date.now = () => clock;
			try { return ulid(time, () => 0); } finally { Date.now = original; }
		},
		Date: class extends Date { static now() { return clock; } },
	});
	run('Math.random = () => 0;', context);
	run(`${bigint}\n${declarations(sf)}\nclass Service { method = '${method}'; ${literalMethods} }\nglobalThis.service = new Service();`, context);
	const prefix = { aid: 'asdfs000', aidx: 'asdfs000', meid: '8199ece82e7b', meidg: 'g199ece82e7b', objectid: '68f222c0', ulid: '01K7T7GBKV' }[method];
	for (const suffix of ['0', method === 'aid' || method === 'aidx' ? 'z' : method === 'ulid' ? 'Z' : 'f']) {
		const noiseLength = { aid: 2, aidx: 8, meid: 12, meidg: 12, objectid: 16, ulid: 16 }[method];
		const id = prefix + suffix.repeat(noiseLength);
		const full = context.service.parseFull(id);
		existingIds.push({ method, id, parsedAt: context.service.parse(id).date.getTime(), full: { date: full.date, additional: full.additional.toString() } });
	}
	for (const [label, value] of inputs) {
		clock = label === 'clock-zero' || label === 'clock-negative' ? value : label.includes('rollover') || label.startsWith('ulid-') ? value + 1 : now;
		const input = label === 'omitted' ? undefined : label === 'nan' ? NaN : value;
		const item = { method, label, atMs: value, now: clock, safe: context.service.isSafeT(input) };
		let id;
		try {
			id = context.service.gen(input);
		} catch (error) {
			item.error = { name: error.name };
			cases.push(item);
			continue;
		}
		{
			const noiseLength = { aid: 2, aidx: 8, meid: 12, meidg: 12, objectid: 16, ulid: 16 }[method];
			item.generated = { prefix: id.slice(0, -noiseLength), length: id.length };
			// These generated IDs use the explicit deterministic random doubles above.
			item.id = id;
			item.parsedAt = context.service.parse(id).date.getTime();
			const full = context.service.parseFull(id);
			item.full = { date: full.date, additional: full.additional.toString() };
		}
		cases.push(item);
	}
}
const output = JSON.stringify({ upstreamCommit: pin, manifest, doubles: ['Date.now fixed per case', 'Math.random=0', 'AID crypto seed=0', 'AIDX nodeId=0000', 'ulid uses installed 3.0.2; compare only timestamp and length'], cases, existingIds }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output);
else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`ID fixed source: ${cases.length} cases ${process.argv[2]}`);
