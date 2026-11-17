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
 const bytes = execFileSync('git', ['show', `${pin}:${path}`], { cwd: process.env.BACKEND_NEXT_UPSTREAM_PATH ?? root });
 manifest.push({ path, sha256: sha(bytes) });
 return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function evaluate(text) { return vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 })); }
const entity = source('packages/backend/src/core/entities/UserEntityService.ts');
const members = entity.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'UserEntityService').members;
const service = {};
for (const name of ['getRelation', 'getRelations']) {
 const method = members.find(n => n.name?.getText(entity) === name);
 assert(method && ts.isMethodDeclaration(method), name);
 service[name] = evaluate(`(async function(${method.parameters.map(p => p.getText(entity)).join(',')}) ${method.body.getText(entity)})`);
}
const endpoint = source('packages/backend/src/server/api/endpoints/users/relation.ts');
const declarations = endpoint.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []);
const meta = evaluate(`(${declarations.find(n => n.name.getText(endpoint) === 'meta').initializer.getText(endpoint)})`);
const schema = evaluate(`(${declarations.find(n => n.name.getText(endpoint) === 'paramDef').initializer.getText(endpoint)})`);
const ctor = endpoint.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
const callback = ctor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression.arguments[2];
const handle = evaluate(`(async function(${callback.parameters.map(p => p.getText(endpoint)).join(',')}) ${callback.body.getText(endpoint)})`);
const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const validate = ajv.compile(schema);
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
function repository(rows) {
 const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
 return {
  async findOneBy(where) { return rows.find(row => matches(row, where)) ?? null; },
  async exists({ where }) { return rows.some(row => matches(row, where)); },
  async findBy(where) { return rows.filter(row => matches(row, where)); },
  createQueryBuilder(alias) {
   let selected; let where;
   return {
    select(field) { selected = field.split('.')[1]; return this; },
    where(expression, { me }) { where = { [expression.match(/\.(\w+) =/)[1]]: me }; return this; },
    async getRawMany() { return rows.filter(row => matches(row, where)).map(row => ({ [`${alias}_${selected}`]: row[selected] })); },
   };
  },
 };
}
let dataSource;
let items = corpus.cases;
if (process.argv[2] === '--pg') {
 const request = JSON.parse(readFileSync(0, 'utf8'));
 const { createDataSource } = await import(new URL('../../../../packages/backend-next/built/platform/database/data-source.js', import.meta.url));
 dataSource = createDataSource(request.database);
 await dataSource.initialize();
 items = request.cases;
 for (const [key, name] of [['followingsRepository', 'following'], ['followRequestsRepository', 'follow_request'], ['blockingsRepository', 'blocking'], ['mutingsRepository', 'muting'], ['renoteMutingsRepository', 'renote_muting']]) service[key] = dataSource.getRepository(name);
} else {
 for (const [key, table] of [['followingsRepository', 'following'], ['followRequestsRepository', 'follow_request'], ['blockingsRepository', 'blocking'], ['mutingsRepository', 'muting'], ['renoteMutingsRepository', 'renote_muting']]) service[key] = repository(corpus.rows[table]);
}
const cases = [];
try {
 for (const item of items) {
  const input = structuredClone(item.input);
  const result = validate(input) ? { result: await handle.call({ userEntityService: service }, input, { id: item.viewerId }) } : { error: { code: 'INVALID_PARAM' } };
  cases.push({ id: item.id, ...result });
 }
} finally { await dataSource?.destroy(); }
if (process.argv[2] === '--pg') {
 process.stdout.write(JSON.stringify(cases));
} else {
 const output = JSON.stringify({ upstreamCommit: pin, manifest, corpusSha256: sha(corpusBytes), access: { requireCredential: meta.requireCredential, kind: meta.kind }, doubles: corpus.doubles, cases }, null, 2) + '\n';
 const target = new URL('./observations.json', import.meta.url);
 if (process.argv[2] === '--write') writeFileSync(target, output);
 else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(target, 'utf8'), output); }
 console.log(`user-relation fixed source: ${cases.length} cases ${process.argv[2]}`);
}
