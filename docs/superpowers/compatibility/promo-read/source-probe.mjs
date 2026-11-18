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
const manifest = [];
function source(path) {
	const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: root });
	manifest.push({ path, sha256: sha(bytes) });
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
class ApiError extends Error {
	constructor(meta) { super(meta.message); this.code = meta.code; this.id = meta.id; }
}
class IdentifiableError extends Error {
	constructor(id, message) { super(message); this.id = id; }
}
const globals = { ApiError, IdentifiableError };
function evaluate(text) {
	return vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), globals);
}
const sf = source('packages/backend/src/server/api/endpoints/promo/read.ts');
const variables = sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []);
const meta = evaluate(`(${variables.find(n => n.name.getText(sf) === 'meta').initializer.getText(sf)})`);
globals.meta = meta;
const schema = evaluate(`(${variables.find(n => n.name.getText(sf) === 'paramDef').initializer.getText(sf)})`);
const ctor = sf.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
const callback = ctor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression.arguments[2];
const handle = evaluate(`(async function(${callback.parameters.map(p => p.getText(sf)).join(',')}) ${callback.body.getText(sf)})`);
const getterSource = source('packages/backend/src/server/api/GetterService.ts');
const method = getterSource.statements.find(ts.isClassDeclaration).members.find(n => n.name?.getText(getterSource) === 'getNote');
const getNote = evaluate(`(async function(${method.parameters.map(p => p.getText(getterSource)).join(',')}) ${method.body.getText(getterSource)})`);
source('packages/backend/src/models/PromoRead.ts');
const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const validate = ajv.compile(schema);
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
let dataSource;
let items = corpus.cases;
let preserve = false;
if (process.argv[2] === '--pg') {
	const request = JSON.parse(readFileSync(0, 'utf8'));
	assert.match(request.database?.database ?? '', /^backend_next_[0-9a-f]{32}$/, 'promo probe requires a disposable test database');
	assert(['127.0.0.1', 'localhost', '::1'].includes(request.database.host), 'promo probe requires a local test database');
	const { createDataSource } = await import(new URL('../../../../packages/backend-next/built/platform/database/data-source.js', import.meta.url));
	dataSource = await createDataSource(request.database).initialize();
	items = request.cases;
	preserve = request.preserve === true;
}
const cases = [];
try {
	for (const item of items) {
		let rows = structuredClone(item.rows);
		const fail = operation => { if (item.fail === operation)
			throw Error(`${operation} unavailable`); };
		const promos = dataSource?.getRepository('promo_read') ?? {
			async exists({ where }) { fail('exists'); return rows.some(row => row.noteId === where.noteId && row.userId === where.userId); },
			async insert(row) { fail('insert'); rows.push(row); },
		};
		const notes = dataSource?.getRepository('note') ?? {
			async findOneBy({ id }) { fail('note'); return corpus.notes.find(note => note.id === id) ?? null; },
		};
		if (dataSource && !preserve) {
			await promos.clear();
			if (rows.length)
				await promos.insert(rows);
		}
		let error;
		try {
			const input = structuredClone(item.input);
			if (!validate(input))
				error = { code: 'INVALID_PARAM' };
			else
				await handle.call({ promoReadsRepository: promos, idService: { gen: () => 'generated' }, getterService: { getNote: id => getNote.call({ notesRepository: notes }, id) } }, input, { id: item.userId ?? 'reader' });
		}
		catch (caught) {
			assert.notEqual(caught.name, 'ReferenceError');
			error = caught.code && caught.id ? { code: caught.code, id: caught.id } : dataSource ? { code: 'INTERNAL_ERROR' } : { message: caught.message };
		}
		if (dataSource && !preserve)
			rows = (await promos.find({ order: { id: 'ASC' } })).map(row => ({ id: row.id, noteId: row.noteId, userId: row.userId }));
		rows.sort((a, b) => a.noteId.localeCompare(b.noteId) || a.userId.localeCompare(b.userId));
		cases.push({ id: item.id, ...(error ? { error } : {}), ...(!preserve ? { rows } : {}) });
	}
}
finally {
	await dataSource?.destroy();
}
if (process.argv[2] === '--pg') {
	process.stdout.write(JSON.stringify(cases));
}
else {
	const output = JSON.stringify({ upstreamCommit: pin, manifest, corpusSha256: sha(corpusBytes), doubles: corpus.doubles, access: { requireCredential: meta.requireCredential, requireModerator: meta.requireModerator, kind: meta.kind }, cases }, null, 2) + '\n';
	const target = new URL('./observations.json', import.meta.url);
	if (process.argv[2] === '--write')
		writeFileSync(target, output);
	else {
		assert.equal(process.argv[2], '--check');
		assert.equal(readFileSync(target, 'utf8'), output);
	}
	console.log(`promo/read fixed source: ${cases.length} cases ${process.argv[2]}`);
}
