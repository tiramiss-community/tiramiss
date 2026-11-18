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
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const ts = require('typescript');
const sources = {};
function source(path) {
	const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: process.env.UPSTREAM_ROOT ?? new URL('../../../..', import.meta.url) });
	sources[path] = createHash('sha256').update(bytes).digest('hex');
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
const cacheFile = source('packages/backend/src/misc/cache.ts');
const serviceFile = source('packages/backend/src/core/AvatarDecorationService.ts');
const endpointFile = source('packages/backend/src/server/api/endpoints/get-avatar-decorations.ts');
const cacheClass = cacheFile.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'MemorySingleCache');
const serviceClass = serviceFile.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'AvatarDecorationService');
let now = 0;
const context = { Date: class extends Date { static now() { return now; } } };
const compile = text => vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const methods = ['get', 'set', 'delete', 'fetch'].map(name => cacheClass.members.find(n => n.name?.getText() === name).getText().replace('@bindThis', '')).join('\n');
const Cache = compile(`(class { constructor(lifetime) { this.lifetime=lifetime; this.cachedAt=null; } ${methods} })`);
function method(name) {
	const m = serviceClass.members.find(n => n.name?.getText() === name);
	return compile(`(function(${m.parameters.map(p => p.getText()).join(',')}) ${m.body.getText()})`);
}
const getAll = method('getAll');
const onMessage = method('onMessage');
let superCall;
function visit(node) {
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) superCall = node;
	ts.forEachChild(node, visit);
}
visit(endpointFile);
const rows = [
	{ id: 'second', name: '星 & 🌟', description: '', url: 'https://local.test/two', category: null, roleIdsThatCanBeUsedThisDecoration: ['private', 'public', 'missing', 'public'], updatedAt: null },
	{ id: 'first', name: 'First', description: '<description>', url: 'https://local.test/one', category: 'category', roleIdsThatCanBeUsedThisDecoration: [], updatedAt: '2000-01-01' },
];
const roles = [{ id: 'public', isPublic: true }, { id: 'private', isPublic: false }];
let reads = 0;
let fail = false;
const receiver = { cache: new Cache(1800000), avatarDecorationsRepository: { async find() { reads++; if (fail) throw new Error('DB unavailable'); return structuredClone(rows); } } };
const endpoint = compile(`(function() { return (${superCall.arguments[2].getText()}); })`).call({ avatarDecorationService: { getAll: value => getAll.call(receiver, value) }, roleService: { async getRoles() { return roles; } } });
const projection = [];
for (const authenticated of [false, true]) {
	reads = 0;
	projection.push({ authenticated, result: await endpoint({}, authenticated ? { id: 'viewer' } : null), reads });
}
receiver.cache.delete();
reads = 0;
const timeline = [];
async function observe(label, noCache = false) {
	let error = null;
	try { await getAll.call(receiver, noCache); } catch (e) { error = e.message; }
	timeline.push({ label, reads, error });
}
await observe('cold');
now = 1800000;
await observe('exact TTL');
now++;
await observe('expired');
for (const type of ['unrelated', 'avatarDecorationCreated', 'avatarDecorationUpdated', 'avatarDecorationDeleted']) {
	await onMessage.call(receiver, 'host', JSON.stringify({ channel: 'internal', message: { type, body: {} } }));
	await observe(type);
}
fail = true;
await observe('forced failure', true);
fail = false;
await observe('retry');
const output = JSON.stringify({ pin, sources, scope: 'Literal pinned getAll/onMessage, MemorySingleCache methods and endpoint callback; repository and RoleService doubles; no upstream HTTP/PG', rows, roles, projection, timeline }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output);
else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`avatar decoration source: ${projection.length} projections, ${timeline.length} cache observations PASS`);
