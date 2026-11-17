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
assert(root, 'Set BACKEND_NEXT_UPSTREAM_PATH to pinned Git objects');
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const paths = ['packages/backend/src/server/api/ApiCallService.ts', 'packages/backend/src/server/api/error.ts'];
const sources = paths.map(path => execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8' }));
const trees = sources.map((source, i) => ts.createSourceFile(paths[i], source, ts.ScriptTarget.Latest, true));
const compile = (text, sandbox = {}) => vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), sandbox);
const errorClass = trees[1].statements.find(ts.isClassDeclaration);
const ApiError = compile(`(function(){ ${errorClass.getText(trees[1]).replace(/^export /, '')}; return ApiError; })()`);
let gate;
function visit(node) {
	if (ts.isIfStatement(node) && node.expression.getText(trees[0]) === 'ep.meta.requireCredential || ep.meta.requireModerator || ep.meta.requireAdmin') {
		const missing = node.thenStatement.statements.find(statement => ts.isIfStatement(statement) && statement.expression.getText(trees[0]) === 'user == null');
		assert(missing);
		gate = compile(`(function(ep, user){ if (${node.expression.getText(trees[0])}) { if (${missing.expression.getText(trees[0])}) ${missing.thenStatement.getText(trees[0])} } })`, { ApiError });
	}
	ts.forEachChild(node, visit);
}
visit(trees[0]);
assert(gate);
const endpoint = JSON.parse(readFileSync(new URL('./source-observations.json', import.meta.url), 'utf8'));
let failure;
try { gate({ meta: endpoint.meta }, null); } catch (error) { failure = error; }
assert(failure instanceof ApiError);
const result = { revision, inputs: paths.map((path, i) => ({ path, sha256: createHash('sha256').update(sources[i]).digest('hex') })),
	endpointIdentity: endpoint.identity,
	status: failure.httpStatusCode,
	body: { error: { message: failure.message, code: failure.code, id: failure.id, kind: failure.kind } },
	scope: 'Literal missing-credential gate and ApiError constructor with pinned endpoint meta. Full upstream HTTP/authentication is not measured.' };
const output = new URL('./auth-observations.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
else assert.deepEqual(result, JSON.parse(readFileSync(output, 'utf8')));
console.log('PASS: pinned missing-credential gate and ApiError');
