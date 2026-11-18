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

const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const upstream = process.env.UPSTREAM_ROOT;
assert(upstream, 'UPSTREAM_ROOT required');
assert(['--write', '--check'].includes(process.argv[2]));
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const dependencies = createRequire(`${process.env.UPSTREAM_DEPENDENCIES_ROOT ?? upstream}/packages/backend/package.json`);
const ts = require('typescript');
const Fastify = dependencies('fastify');
const sourcePaths = ['packages/backend/src/server/NodeinfoServerService.ts', 'packages/backend/src/misc/cache.ts', 'packages/backend/src/server/WellKnownServerService.ts', 'packages/backend/src/misc/prelude/xml.ts', 'packages/backend/src/const.ts', 'packages/backend/src/core/RoleService.ts'];
const sources = sourcePaths.map(path => {
	const bytes = readFileSync(`${upstream}/${path}`);
	assert.deepEqual(bytes, execFileSync('git', ['-C', upstream, 'show', `${pin}:${path}`]));
	return [path, createHash('sha256').update(bytes).digest('hex')];
});
const nodeSource = ts.createSourceFile('nodeinfo.ts', readFileSync(`${upstream}/${sourcePaths[0]}`, 'utf8'), ts.ScriptTarget.Latest, true);
const nodeClass = nodeSource.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'NodeinfoServerService');
const method = name => {
	const node = nodeClass.members.find(n => n.name?.getText() === name);
	return `(function(${node.parameters.map(p => p.getText()).join(',')})${node.body.getText()})`;
};
const cacheSource = ts.createSourceFile('cache.ts', readFileSync(`${upstream}/${sourcePaths[1]}`, 'utf8'), ts.ScriptTarget.Latest, true);
const cacheClass = cacheSource.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'MemorySingleCache').getText().replace('export class', 'class').replaceAll('@bindThis', '');
function sourceConstant(path, name) {
	const file = ts.createSourceFile(path, readFileSync(`${upstream}/${path}`, 'utf8'), ts.ScriptTarget.Latest, true);
	const declaration = file.statements.flatMap(statement => statement.declarationList?.declarations ?? []).find(node => node.name.getText() === name);
	assert(declaration?.initializer, name);
	return vm.runInNewContext(ts.transpileModule(`(${declaration.initializer.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
}
const maxNoteTextLength = sourceConstant(sourcePaths[4], 'MAX_NOTE_TEXT_LENGTH');
const defaultPolicies = sourceConstant(sourcePaths[5], 'DEFAULT_POLICIES');
const meta = {
	name: 'Local & instance', description: '<p>hello</p>', maintainerName: 'Admin', maintainerEmail: 'admin@local.test', langs: ['ja-JP', 'en-US'], termsOfServiceUrl: null, privacyPolicyUrl: 'https://local.test/privacy', inquiryUrl: null, impressumUrl: null, repositoryUrl: 'https://source.test/fork', feedbackUrl: 'https://local.test/feedback', disableRegistration: false, emailRequiredForSignup: true, enableHcaptcha: false, enableRecaptcha: false, enableMcaptcha: true, enableTurnstile: false, enableEmail: true, enableServiceWorker: false, themeColor: null, policies: { ltlAvailable: false, gtlAvailable: true }, federation: 'all',
};
const scenarios = [
	{ name: '21-first', steps: [{ path: '/nodeinfo/2.1' }, { path: '/nodeinfo/2.0' }, { path: '/nodeinfo/2.1' }, { path: '/nodeinfo/2.1', method: 'HEAD' }, { path: '/nodeinfo/2.0', method: 'HEAD' }, { path: '/nodeinfo/2.1', method: 'OPTIONS' }, { path: '/nodeinfo/unknown' }] },
	{ name: '20-first-expiry', steps: [{ path: '/nodeinfo/2.0' }, { path: '/nodeinfo/2.1' }, { path: '/nodeinfo/2.1', advance: 600000, changed: true }, { path: '/nodeinfo/2.1', advance: 1, changed: true }] },
	{ name: 'head-first', steps: [{ path: '/nodeinfo/2.0', method: 'HEAD' }, { path: '/nodeinfo/2.1' }] },
	{ name: 'null-settings', meta: { name: null, description: null, maintainerName: null, maintainerEmail: null, repositoryUrl: null, themeColor: '', langs: [] }, steps: [{ path: '/nodeinfo/2.1' }] },
	{ name: 'failed-refresh', steps: [{ path: '/nodeinfo/2.1' }, { path: '/nodeinfo/2.1', advance: 600001, fault: 'notes' }, { path: '/nodeinfo/2.1', changed: true }] },
	{ name: 'federation-none', meta: { federation: 'none', policies: {}, disableRegistration: true, themeColor: '#abcdef' }, steps: [{ path: '/nodeinfo/2.1' }, { path: '/nodeinfo/2.0' }] },
	...['notes', 'users', 'meta', 'proxy'].map(fault => ({ name: `fault-${fault}`, steps: [{ path: '/nodeinfo/2.1', fault }, { path: '/nodeinfo/2.0' }] })),
];
const observations = [];
for (const scenario of scenarios) {
	let now = 1800000000000;
	let step;
	const calls = [];
	const context = { Date: { now: () => now }, MAX_NOTE_TEXT_LENGTH: maxNoteTextLength, DEFAULT_POLICIES: defaultPolicies, nodeinfo2_1path: '/nodeinfo/2.1', nodeinfo2_0path: '/nodeinfo/2.0', nodeinfo_homepage: 'https://misskey-hub.net' };
	context.MemorySingleCache = vm.runInNewContext(ts.transpileModule(`${cacheClass}; MemorySingleCache`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
	const createServer = vm.runInNewContext(ts.transpileModule(method('createServer'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
	const receiver = {
		config: { url: 'https://local.test:8443', version: '2026.10.1-alpha.0' },
		notesChart: { async getChart(...args) { calls.push(['notes', ...args]); if (step.fault === 'notes') { throw Error('injected notes failure'); } return { local: { total: [step.changed ? 52 : 42] } }; } },
		usersChart: { async getChart(...args) { calls.push(['users', ...args]); if (step.fault === 'users') { throw Error('injected users failure'); } return { local: { total: [step.changed ? 17 : 7] } }; } },
		metaService: { async fetch(...args) { calls.push(['meta', ...args]); if (step.fault === 'meta') { throw Error('injected meta failure'); } return { ...meta, ...scenario.meta, ...(step.changed ? { name: 'Changed instance' } : {}) }; } },
		systemAccountService: { async fetch(...args) { calls.push(['proxy', ...args]); if (step.fault === 'proxy') { throw Error('injected proxy failure'); } return { username: 'system.proxy' }; } },
	};
	const getLinks = vm.runInNewContext(ts.transpileModule(method('getLinks'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
	const app = Fastify();
	app.register(createServer.bind(receiver));
	await app.listen({ host: '127.0.0.1', port: 0 });
	try {
		for (step of scenario.steps) {
			now += step.advance ?? 0;
			calls.length = 0;
			const response = await fetch(`http://127.0.0.1:${app.server.address().port}${step.path}`, { method: step.method ?? 'GET' });
			const body = await response.text();
			observations.push({ scenario: scenario.name, step, meta: { ...meta, ...scenario.meta }, status: response.status, headers: Object.fromEntries(['access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin', 'access-control-expose-headers', 'cache-control', 'vary', 'content-type'].map(key => [key, response.headers.get(key)])), body: response.status === 200 && step.method !== 'HEAD' ? JSON.parse(body) : null, calls: [...calls] });
		}
	} finally { await app.close(); }
	assert.deepEqual(JSON.parse(JSON.stringify(getLinks.call(receiver))), [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://local.test:8443/nodeinfo/2.1' }, { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: 'https://local.test:8443/nodeinfo/2.0' }]);
}
const xml = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(`${upstream}/${sourcePaths[3]}`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, xml);
const wellKnownSource = ts.createSourceFile('well-known.ts', readFileSync(`${upstream}/${sourcePaths[2]}`, 'utf8'), ts.ScriptTarget.Latest, true);
const wellKnownMethod = wellKnownSource.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'WellKnownServerService').members.find(n => n.name?.getText() === 'createServer');
const wellKnownServer = vm.runInNewContext(ts.transpileModule(`(function(${wellKnownMethod.parameters.map(p => p.getText()).join(',')})${wellKnownMethod.body.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { ...xml.exports, fastifyAccepts: dependencies('@fastify/accepts'), IsNull: dependencies('typeorm').IsNull, vary: dependencies('vary'), URL });
const linkMethod = vm.runInNewContext(ts.transpileModule(method('getLinks'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { nodeinfo2_1path: '/nodeinfo/2.1', nodeinfo2_0path: '/nodeinfo/2.0' });
const discovery = [];
for (const federation of ['all', 'none', 'fault']) {
	const app = Fastify();
	let metaReads = 0;
	const config = { url: 'https://local.test:8443' };
	app.register(wellKnownServer.bind({ config, get meta() { metaReads++; if (federation === 'fault') { throw Error('injected Meta failure'); } return { federation }; }, nodeinfoServerService: { getLinks: () => linkMethod.call({ config }) } }));
	await app.listen({ host: '127.0.0.1', port: 0 });
	try {
		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			metaReads = 0;
			const response = await fetch(`http://127.0.0.1:${app.server.address().port}/.well-known/nodeinfo`, { method });
			const body = await response.text();
			discovery.push({ federation, method, status: response.status, metaReads, headers: Object.fromEntries(['access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin', 'access-control-expose-headers', 'cache-control', 'vary', 'content-type'].map(key => [key, response.headers.get(key)])), body });
		}
	} finally { await app.close(); }
}
const output = JSON.stringify({ upstreamCommit: pin, sources, discovery, method: 'Literal NodeinfoServerService, MemorySingleCache and WellKnownServerService discovery, listening Fastify; chart/Meta/proxy doubles, no upstream DB/full app', dependencies: { fastify: dependencies('fastify/package.json').version }, observations }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') { writeFileSync(target, output); } else { assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`nodeinfo source: ${observations.length + discovery.length} listening HTTP observations PASS`);
