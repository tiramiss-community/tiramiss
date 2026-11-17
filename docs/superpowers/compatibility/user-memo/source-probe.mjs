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
const { Ajv } = require('ajv');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = new URL('../../../../', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: root });
const manifest = [];
function source(path) {
	const bytes = git('show', `${pin}:${path}`);
	manifest.push({ path, gitBlob: git('rev-parse', `${pin}:${path}`).toString().trim(), sha256: sha(bytes) });
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
class ApiError extends Error {
	constructor(meta) { super(meta.message); this.code = meta.code; this.id = meta.id; }
}
const globals = { ApiError };
function evaluate(text) {
	return vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), globals);
}
const sf = source('packages/backend/src/server/api/endpoints/users/update-memo.ts');
const variables = sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []);
const meta = evaluate(`(${variables.find(n => n.name.getText(sf) === 'meta').initializer.getText(sf)})`);
globals.meta = meta;
const schema = evaluate(`(${variables.find(n => n.name.getText(sf) === 'paramDef').initializer.getText(sf)})`);
const ctor = sf.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
const callback = ctor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression.arguments[2];
const update = evaluate(`(async function(${callback.parameters.map(p => p.getText(sf)).join(',')}) ${callback.body.getText(sf)})`);
const userSource = source('packages/backend/src/core/entities/UserEntityService.ts');
const pack = userSource.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'UserEntityService').members.find(n => n.name?.getText(userSource) === 'pack');
const declaration = pack.body.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(userSource) === 'memo'));
const branch = pack.body.statements.find(n => ts.isIfStatement(n) && n.expression.getText(userSource) === 'isDetailed && meId');
assert(declaration && branch, 'literal viewer memo block');
const read = evaluate(`(async function(isDetailed, meId, user, opts) { ${declaration.getText(userSource)} ${branch.getText(userSource)} return memo; })`);
source('packages/backend/src/models/UserMemo.ts');
source('packages/backend/src/server/api/GetterService.ts');
const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const validate = ajv.compile(schema);
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const cases = [];
for (const item of corpus.cases) {
	let rows = structuredClone(item.rows);
	const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
	const fail = operation => { if (item.fail === operation) throw Error(`${operation} unavailable`); };
	const repository = {
		async findOneBy(where) { fail('find'); return rows.find(row => matches(row, where)) ?? null; },
		async insert(row) { fail('insert'); rows.push(structuredClone(row)); },
		async update(id, change) { fail('update'); rows = rows.map(row => row.id === id ? { ...row, ...change } : row); },
		async delete(where) { fail('delete'); rows = rows.filter(row => !matches(row, where)); },
	};
	let error;
	try {
		const input = structuredClone(item.input);
		if (!validate(input)) { error = { code: 'INVALID_PARAM' }; }
		else await update.call({ userMemosRepository: repository, getterService: { async getUser(id) { fail('target'); if (!corpus.users.includes(id)) throw { id: '15348ddd-432d-49c2-8a5a-8069753becff' }; return { id }; } }, idService: { gen: () => corpus.newId } }, input, { id: corpus.actorId });
	} catch (caught) { assert.notEqual(caught.name, 'ReferenceError'); error = caught.code ? { code: caught.code, id: caught.id } : { message: caught.message }; }
	const reads = [];
	// Read failures are tested separately; these reads inspect successful or unchanged persisted rows.
	const reader = { userMemosRepository: { async findOneBy(where) { return rows.find(row => matches(row, where)) ?? null; } } };
	for (const viewerId of [corpus.actorId, 'bob', null]) {
		reads.push({ viewerId, memo: await read.call(reader, true, viewerId, { id: item.input.userId }, {}) });
	}
	assert.equal(await read.call(reader, false, corpus.actorId, { id: item.input.userId }, {}), null);
	cases.push({ id: item.id, ...(error ? { error } : {}), rows, reads });
}
const output = JSON.stringify({ upstreamCommit: pin, manifest, corpusSha256: sha(corpusBytes), doubles: corpus.doubles, access: { requireCredential: meta.requireCredential, kind: meta.kind }, cases }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output);
else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`user-memo fixed source: ${cases.length} cases ${process.argv[2]}`);
