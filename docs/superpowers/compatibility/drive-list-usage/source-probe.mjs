/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { domainToASCII } from 'node:url';
import vm from 'node:vm';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { Ajv } = require('ajv');
const { DataSource, EntitySchema } = require('typeorm');
const root = process.env.UPSTREAM_ROOT;
assert(root);
assert(['--write', '--check'].includes(process.argv[2]));
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = [];
const globals = { domainToASCII, counter: 0, nodeId: '0000' };
function source(path) {
 const bytes = readFileSync(`${root}/${path}`);
 assert.deepEqual(bytes, execFileSync('git', ['-C', root, 'show', `${pin}:${path}`]));
 manifest.push({ path, sha256: sha(bytes), gitBlob: execFileSync('git', ['-C', root, 'rev-parse', `${pin}:${path}`]).toString().trim() });
 return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function evaluate(text) { return vm.runInNewContext(ts.transpile(`(${text})`, { target: ts.ScriptTarget.ES2022 }), globals); }
function compile(node, sf) { return evaluate(`${node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)}`); }
function variable(sf, name) { return sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(sf) === name); }
function methods(sf, name) { return Object.fromEntries(sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name).members.filter(ts.isMethodDeclaration).map(n => [n.name.getText(sf), compile(n, sf)])); }
const aidx = source('packages/backend/src/misc/id/aidx.ts');
for (const name of ['TIME2000', 'TIME_LENGTH', 'NOISE_LENGTH']) { globals[name] = evaluate(variable(aidx, name).initializer.getText(aidx)); }
for (const name of ['getTime', 'getNoise', 'genAidx']) { globals[name] = compile(aidx.statements.find(n => n.name?.getText(aidx) === name), aidx); }
const ids = methods(source('packages/backend/src/core/IdService.ts'), 'IdService');
const pagination = methods(source('packages/backend/src/core/QueryService.ts'), 'QueryService');
const fileMethods = methods(source('packages/backend/src/core/entities/DriveFileEntityService.ts'), 'DriveFileEntityService');
const utility = methods(source('packages/backend/src/core/UtilityService.ts'), 'UtilityService');
const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const endpoints = {};
for (const [op, path] of [['usage', 'drive'], ['files', 'drive/files'], ['stream', 'drive/stream'], ['folders', 'drive/folders'], ['adminFiles', 'admin/drive/files']]) {
 const sf = source(`packages/backend/src/server/api/endpoints/${path}.ts`);
 const ctor = sf.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
 const call = ctor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression;
 endpoints[op] = { validate: ajv.compile(evaluate(variable(sf, 'paramDef').initializer.getText(sf))), handle: compile(call.arguments[2], sf) };
}
const bytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(bytes);
const column = (type = String, nullable = true) => ({ type, nullable });
const schemas = [new EntitySchema({ name: 'File', tableName: 'drive_file', columns: { id: { type: String, primary: true }, userId: column(), userHost: column(), folderId: column(), name: column(), type: column(), size: column(Number, false), isLink: column(Boolean, false) } }), new EntitySchema({ name: 'Folder', tableName: 'drive_folder', columns: { id: { type: String, primary: true }, userId: column(), parentId: column(), name: column() } })];
const db = { type: 'postgres', host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55432), username: 'postgres', password: 'foundation-test-only' };
const admin = new DataSource({ ...db, database: 'backend_next_test' });
const name = `drive507_${randomUUID().replaceAll('-', '')}`;
let data;
const cases = [];
await admin.initialize();
try {
 await admin.query(`CREATE DATABASE "${name}"`);
 data = new DataSource({ ...db, database: name, entities: schemas, synchronize: true });
 await data.initialize();
 const files = data.getRepository('File');
 const folders = data.getRepository('Folder');
 await files.insert(corpus.rows);
 await folders.insert(corpus.folders);
 const receiver = { ...fileMethods, driveFilesRepository: files, driveFoldersRepository: folders, utilityService: utility,
  queryService: { ...pagination, idService: { gen: time => ids.gen.call({ method: 'aidx' }, time) } },
  driveFileEntityService: null, driveFolderEntityService: { async pack(row) { return row.id; } },
  roleService: { async getUserPolicies() { return { driveCapacityMb: 100 }; } },
  async packMany(rows) { return rows.map(row => row.id); },
 };
 receiver.driveFileEntityService = receiver;
 for (const c of corpus.cases) {
  let result;
  const input = structuredClone(c.input);
  if (c.operation === 'aggregate') {
   if ('userId' in input) { result = await fileMethods.calcDriveUsageOf.call(receiver, input.userId); }
   else if ('host' in input) { result = await fileMethods.calcDriveUsageOfHost.call(receiver, input.host); }
   else { result = await fileMethods[input.origin === 'local' ? 'calcDriveUsageOfLocal' : 'calcDriveUsageOfRemote'].call(receiver); }
  } else {
   const ep = endpoints[c.operation];
   if (!ep.validate(input)) { cases.push({ id: c.id, error: 'INVALID_PARAM' }); continue; }
   result = await ep.handle.call(receiver, input, { id: c.actor ?? 'alice' });
  }
  cases.push({ id: c.id, result });
 }
 const output = JSON.stringify({ upstreamCommit: pin, database: 'isolated PostgreSQL; actual TypeORM QueryBuilder', corpusSha256: sha(bytes), manifest, doubles: ['packMany/folder.pack return selected IDs only; existing pack comparison covers JSON', 'Role policies returns driveCapacityMb=100; current Role assignment tested separately', 'AIDX nodeId fixed to 0000 and counter initially zero; date cases avoid timestamp ties', 'HTTP common gate is tested on backend-next separately'], cases }, null, 2) + '\n';
 const target = new URL('./observations.json', import.meta.url);
 if (process.argv[2] === '--write') { writeFileSync(target, output); }
 else { assert.equal(readFileSync(target, 'utf8'), output); }
 console.log(`drive-list-usage source: ${cases.length} cases on PostgreSQL ${process.argv[2]}`);
} finally {
 if (data?.isInitialized) { await data.destroy(); }
 await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
 await admin.destroy();
}
