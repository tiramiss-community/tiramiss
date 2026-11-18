/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { migrateDatabase } from '../../../../packages/backend-next/built/platform/database/migrate.js';
import { createDataSource } from '../../../../packages/backend-next/built/platform/database/data-source.js';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { Ajv } = require('ajv');
const { DataSource } = require('typeorm');
const { MiHashtag } = await import('../../../../packages/backend-upstream/built/exports/entities.js');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const root = new URL('../../../../', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = [];
function source(path) {
	const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: root });
	manifest.push({ path, sha256: sha(bytes) });
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
class ApiError extends Error {
	constructor(meta) { super(meta.message); this.code = meta.code; this.id = meta.id; }
}
const globals = { ApiError };
const evaluate = text => vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), globals);
function method(sf, name) {
	const value = sf.statements.find(ts.isClassDeclaration).members.find(node => node.name?.getText(sf) === name);
	return evaluate(`(async function(${value.parameters.map(p => p.getText(sf)).join(',')}) ${value.body.getText(sf)})`);
}
for (const [path, name] of [['misc/normalize-for-search.ts', 'normalizeForSearch'], ['misc/sql-like-escape.ts', 'sqlLikeEscape']]) {
	const sf = source(`packages/backend/src/${path}`);
	const fn = sf.statements.find(ts.isFunctionDeclaration);
	globals[name] = evaluate(`(function(${fn.parameters.map(p => p.getText(sf)).join(',')}) ${fn.body.getText(sf)})`);
}
const packSource = source('packages/backend/src/core/entities/HashtagEntityService.ts');
const packer = { pack: method(packSource, 'pack'), packMany: method(packSource, 'packMany') };
const endpoints = {};
for (const name of ['list', 'search', 'show']) {
	const sf = source(`packages/backend/src/server/api/endpoints/hashtags/${name}.ts`);
	const variables = sf.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
	const meta = evaluate(`(${variables.find(node => node.name.getText(sf) === 'meta').initializer.getText(sf)})`);
	const schema = evaluate(`(${variables.find(node => node.name.getText(sf) === 'paramDef').initializer.getText(sf)})`);
	const ctor = sf.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
	const callback = ctor.body.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression.arguments[2];
	// Each callback gets its own literal endpoint meta (including the show error identity).
	const run = evaluate(`((meta) => async function(${callback.parameters.map(p => p.getText(sf)).join(',')}) ${callback.body.getText(sf)})`)(meta);
	endpoints[name] = { run, validate: new Ajv({ useDefaults: true }).compile(schema), requireCredential: meta.requireCredential };
}
source('packages/backend/src/models/Hashtag.ts');
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const config = { host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55432), username: 'postgres', password: 'foundation-test-only', database: 'backend_next_test' };
const admin = new DataSource({ type: 'postgres', ...config });
const database = `hashtag_source_${randomUUID().replaceAll('-', '')}`;
let connection;
const cases = [];
await admin.initialize();
await admin.query(`CREATE DATABASE "${database}"`);
try {
	config.database = database;
	await migrateDatabase(config);
	connection = createDataSource(config);
	await connection.initialize();
	const repository = connection.getRepository(MiHashtag);
	await repository.insert(corpus.rows);
	const before = await repository.find({ order: { id: 'ASC' } });
	for (const item of corpus.cases) {
		const endpoint = endpoints[item.endpoint];
		const input = structuredClone(item.input);
		let result;
		let error;
		try {
			if (!endpoint.validate(input)) error = { code: 'INVALID_PARAM' };
			else result = await endpoint.run.call({ hashtagsRepository: repository, hashtagEntityService: packer }, input, null);
		} catch (caught) {
			assert.notEqual(caught.name, 'ReferenceError');
			error = { code: caught.code, ...(caught.id ? { id: caught.id, message: caught.message } : {}) };
		}
		cases.push({ id: item.id, ...(error ? { error } : { result }) });
	}
	assert.deepEqual(await repository.find({ order: { id: 'ASC' } }), before, 'literal source reads preserve all producer columns');
} finally {
	await connection?.destroy();
	await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
	await admin.destroy();
}
const output = JSON.stringify({ upstreamCommit: pin, manifest, corpusSha256: sha(corpusBytes), method: 'Literal fixed-source endpoint callbacks, schemas, normalizer, SQL escaping and packer; actual TypeORM repository and PostgreSQL; no Nest/whole upstream HTTP server.', access: Object.fromEntries(Object.entries(endpoints).map(([name, endpoint]) => [name, { requireCredential: endpoint.requireCredential }])), cases }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output);
else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`hashtag fixed source PostgreSQL: ${cases.length} cases ${process.argv[2]}`);
