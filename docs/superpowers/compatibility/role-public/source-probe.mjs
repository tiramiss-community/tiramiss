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

const root = new URL('../../../../', import.meta.url);
const require = createRequire(new URL('packages/backend-next/package.json', root));
const ts = require('typescript');
const { Brackets, DataSource } = require('typeorm');
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? '/tmp/tiramiss-relay171-upstream';
const upstreamRequire = createRequire(`${upstream}/packages/backend/package.json`);
const Fastify = upstreamRequire('fastify');
const { Ajv } = require('ajv');
const { entities, MiRole, MiRoleAssignment, MiUser } = await import(new URL('packages/backend-upstream/built/exports/entities.js', root));
const { migrateDatabase } = await import(new URL('packages/backend-next/built/platform/database/migrate.js', root));
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert.equal(corpus.upstreamRevision, pin);
const paths = ['server/api/endpoints/roles/list.ts', 'server/api/endpoints/roles/show.ts', 'core/entities/RoleEntityService.ts', 'core/RoleService.ts', 'core/entities/UserEntityService.ts', 'misc/id/aidx.ts'];
const sources = paths.map(path => execFileSync('git', ['show', `${pin}:packages/backend/src/${path}`], { cwd: upstream, encoding: 'utf8' }));
const ast = sources.map((s, i) => ts.createSourceFile(paths[i], s, ts.ScriptTarget.Latest, true));
const klass = i => ast[i].statements.find(ts.isClassDeclaration);
const member = (i, name) => klass(i).members.find(n => n.name?.getText(ast[i]) === name);
const variable = (i, name) => ast[i].statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations]).find(n => n.name.getText(ast[i]) === name).initializer;
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [corpus.atMs])); } static now() { return corpus.atMs; } }
const compile = code => vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), { Date: FixedDate, Brackets, DEFAULT_POLICIES: defaults, awaitAll: async object => Object.fromEntries(await Promise.all(Object.entries(object).map(async ([k, v]) => [k, await v]))), ApiError: class extends Error { constructor(body) { super(body.message); this.body = body; } }, meta: showMeta });
// Literal policy initializer has no service dependencies.
const defaults = vm.runInNewContext(ts.transpile(`(${variable(3, 'DEFAULT_POLICIES').getText(ast[3])})`, { target: ts.ScriptTarget.ES2022 }));
const showMeta = vm.runInNewContext(ts.transpile(`(${variable(1, 'meta').getText(ast[1])})`, { target: ts.ScriptTarget.ES2022 }));
const method = (i, name) => {
 const n = member(i, name);
 return compile(`(function(${n.parameters.map(p => p.getText(ast[i])).join(',')})${n.body.getText(ast[i])})`.replace('(function(', n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? '(async function(' : '(function('));
};
const parseNode = ast[5].statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'parseAidx');
const parse = compile(`(function(id) { const TIME_LENGTH = 8; const TIME2000 = 946684800000; ${parseNode.body.statements.map(n => n.getText(ast[5])).join('\n')} })`);
const config = { host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 15795), username: 'postgres', password: 'foundation-test-only', database: 'backend_next_test', extra: {} };
const admin = new DataSource({ type: 'postgres', ...config });
await admin.initialize();
const database = `role_source_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${database}"`);
const db = new DataSource({ type: 'postgres', ...config, database, entities });
const app = Fastify();
const cases = [];
let userRoles;
try {
 await migrateDatabase({ ...config, database });
 await db.initialize();
 const ids = [...new Set(corpus.assignments.map(row => row.userId))];
 await db.getRepository(MiUser).insert(ids.map((id, n) => ({ id, username: `role-source-${n}`, usernameLower: `role-source-${n}` })));
 await db.getRepository(MiRole).insert(corpus.roles.map(row => ({ ...row, updatedAt: new Date(row.updatedAt), lastUsedAt: new Date(row.lastUsedAt) })));
 await db.getRepository(MiRoleAssignment).insert(corpus.assignments.map(row => ({ ...row, expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt) })));
 const packer = { rolesRepository: db.getRepository(MiRole), roleAssignmentsRepository: db.getRepository(MiRoleAssignment), idService: { parse } };
 packer.pack = method(2, 'pack').bind(packer);
 packer.packMany = method(2, 'packMany').bind(packer);
 const ajv = new Ajv({ useDefaults: true });
 ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
 for (let index = 0; index < 2; index++) {
  const ctor = klass(index).members.find(ts.isConstructorDeclaration);
  const superCall = ctor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression;
  const literal = superCall.arguments[2];
  const callback = compile(`(async function(${literal.parameters.map(p => p.getText(ast[index])).join(',')})${literal.body.getText(ast[index])})`).bind({ rolesRepository: db.getRepository(MiRole), roleEntityService: packer });
  const validate = ajv.compile(compile(`(${variable(index, 'paramDef').getText(ast[index])})`));
  app.post('/api/roles/' + (index === 0 ? 'list' : 'show'), async (request, reply) => {
   if (!validate(request.body)) {
    const error = validate.errors[0];
    return reply.code(400).send({ error: { message: 'Invalid param.', code: 'INVALID_PARAM', id: '3d81ceae-475f-4600-b2a8-2bc116157532', kind: 'client', info: { param: error.schemaPath, reason: error.message } } });
   }
   try { return await callback(request.body, null); } catch (error) { assert(error.body, String(error.stack)); return reply.code(400).send({ error: { ...error.body, kind: 'client' } }); }
  });
 }
 await app.listen({ port: 0, host: '127.0.0.1' });
 for (const item of corpus.cases.filter(item => !['list-anonymous', 'list-scope', 'list-no-scope', 'list-suspended'].includes(item.id))) {
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/roles/${item.endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.input) });
  cases.push({ id: item.id, status: response.status, body: await response.json() });
 }
 const roleService = { userEntityService: { isLocalUser: user => user.host == null }, rolesRepository: db.getRepository(MiRole), roleAssignmentsRepository: db.getRepository(MiRoleAssignment), rolesCache: { fetch: callback => callback() }, roleAssignmentByUserIdCache: { fetch: (_id, callback) => callback() }, cacheService: { findUserById: id => db.getRepository(MiUser).findOneByOrFail({ id }) } };
 for (const name of ['evalCond', 'getUserAssigns', 'getUserRoles']) {
  roleService[name] = method(3, name).bind(roleService);
 }
 let projection;
 const visit = node => { if (ts.isPropertyAssignment(node) && node.name.getText(ast[4]) === 'roles') projection = node.initializer; ts.forEachChild(node, visit); };
 visit(ast[4]);
 assert(projection);
 userRoles = await compile(`(async function(user) { return ${projection.getText(ast[4])}; })`).call({ roleService }, { id: ids[0] });
} finally {
 await app.close();
 if (db.isInitialized) await db.destroy();
 await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
 await admin.destroy();
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const item of cases) {
 assert.equal(item.status, ['list-invalid', 'show-private', 'show-unknown', 'show-missing-param', 'show-invalid-param'].includes(item.id) ? 400 : 200, item.id + ' source outcome');
}
assert.equal(cases[0].body[0].usersCount, 2);
assert(userRoles.some(row => row.name === 'conditional'));
const result = { upstreamRevision: pin, corpusSha256: sha(corpusBytes), source: Object.fromEntries(paths.map((p, i) => [p, sha(sources[i])])), scope: 'literal endpoint callbacks/Role packer/UserDetailed roles expression/getUserRoles/getUserAssigns/evalCond; real PostgreSQL + listening Fastify; explicit fresh cache, fixed clock, Ajv/error wrapper; authentication excluded, not full upstream application', cases, userRoles };
const target = new URL('./observations.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(target, JSON.stringify(result, null, 2) + '\n'); else assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(readFileSync(target, 'utf8')));
console.log(`PASS: ${cases.length} source HTTP/PostgreSQL cases and UserDetailed Role projection`);
