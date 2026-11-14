/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { domainToASCII } from 'node:url';
import ts from 'typescript';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = process.env.UPSTREAM_ROOT ?? '/tmp/tiramiss-relay171-upstream';
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const require = createRequire(`${root}/packages/backend/package.json`);
const { DataSource } = require('typeorm');
const localRequire = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const source = new DataSource({ type: 'postgres', driver: localRequire('pg') });
const sha = x => createHash('sha256').update(x).digest('hex');
const manifest = [];
function read(path) {
 const bytes = execFileSync('git', ['-C', root, 'show', `${pin}:${path}`]);
 manifest.push({ path, sha256: sha(bytes) });
 return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function compile(node, sf) {
 return vm.runInNewContext(ts.transpile(`(async function(${node.parameters.map(p => p.getText(sf)).join(',')})${node.body.getText(sf)})`, { target: ts.ScriptTarget.ES2022 }), { domainToASCII });
}
const handlers = {};
for (const operation of ['update-instance', 'refresh-remote-instance-metadata']) {
 const sf = read(`packages/backend/src/server/api/endpoints/admin/federation/${operation}.ts`);
 let handler;
 function walk(node) {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) handler = node.arguments[2];
  ts.forEachChild(node, walk);
 }
 walk(sf); assert(handler && ts.isArrowFunction(handler)); handlers[operation] = compile(handler, sf);
}
const sf = read('packages/backend/src/core/UtilityService.ts');
const method = sf.statements.find(ts.isClassDeclaration).members.find(n => n.name?.getText(sf) === 'toPuny');
const toPuny = vm.runInNewContext(ts.transpile(`(function(${method.parameters.map(p => p.getText(sf)).join(',')})${method.body.getText(sf)})`, { target: ts.ScriptTarget.ES2022 }), { domainToASCII });
read('packages/backend/src/core/FederatedInstanceService.ts');
const cases = [];
for (const state of ['none', 'manuallySuspended', 'goneSuspended', 'autoSuspendedForNotResponding']) {
 for (const isSuspended of [true, false, undefined]) {
  for (const note of [undefined, '', 'before', 'after']) {
   cases.push({ id: `${state}-${String(isSuspended)}-${note === undefined ? 'omitted' : note || 'empty'}`, operation: 'update-instance', state, input: { host: 'REMOTE.TEST', ...(isSuspended === undefined ? {} : { isSuspended }), ...(note === undefined ? {} : { moderationNote: note }) } });
  }
 }
}
cases.push(...[
 { id: 'idn', input: { host: '例え.TEST', moderationNote: 'after' }, host: 'xn--r8jz45g.test' },
 { id: 'missing', input: { host: 'missing.test', moderationNote: 'after' }, missing: true },
 { id: 'trailing-dot', input: { host: 'remote.test.', moderationNote: 'after' }, missing: true },
 { id: 'port', input: { host: 'remote.test:3000', moderationNote: 'after' }, missing: true },
 { id: 'db-failure', input: { host: 'remote.test', moderationNote: 'after' }, fail: 'db' },
 { id: 'read-failure', input: { host: 'remote.test', moderationNote: 'after' }, fail: 'read' },
].map(x => ({ operation: 'update-instance', ...x })));
for (const state of ['none', 'manuallySuspended', 'goneSuspended', 'autoSuspendedForNotResponding']) cases.push({ id: `refresh-${state}`, operation: 'refresh-remote-instance-metadata', state, input: { host: 'REMOTE.TEST' } });
cases.push({ id: 'refresh-missing', operation: 'refresh-remote-instance-metadata', missing: true, input: { host: 'remote.test' } });
const observations = [];
for (const c of cases) {
 const row = { id: 'instance1', host: c.host ?? 'remote.test', suspensionState: c.state ?? 'none', moderationNote: 'before' };
 const audits = []; const refresh = []; const lookups = []; let error = null;
 const service = {
  instancesRepository: { async findOneBy(where) { lookups.push(where.host); if (c.fail === 'read') throw Error('read rejected'); return c.missing ? null : structuredClone(row); } },
  utilityService: { toPuny },
  federatedInstanceService: { async update(_id, patch) {
   // Real installed upstream QueryBuilder validates empty updates, without opening a DB.
   source.createQueryBuilder().update('instance').set(patch).returning('*').getQuery();
   if (c.fail === 'db') throw Error('DB rejected');
   Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([,v]) => v !== undefined)));
  } },
  moderationLogService: { log(me, type, info) { audits.push({ actorId: me.id, type, info }); } },
  fetchInstanceMetadataService: { fetchInstanceMetadata(instance, force) { refresh.push({ id: instance.id, host: instance.host, force }); return new Promise(() => {}); } },
 };
 try { await handlers[c.operation].call(service, c.input, { id: 'moderator1' }); } catch (e) { error = { name: e.name, message: e.message }; }
 observations.push({ ...c, expected: { row, audits, refresh, lookups, error } });
}
const result = { source: pin, probeSha256: sha(readFileSync(new URL(import.meta.url))), manifest, limits: 'Literal endpoint callback + UtilityService.toPuny; repository/effect doubles and real installed TypeORM empty-update SQL validation. No upstream HTTP, authentication, Redis, PG, cache failure or audit/metadata completion observed.', cases: observations };
const output = JSON.stringify(result, null, 2) + '\n';
const path = new URL('./instance-admin-observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(path, output); else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(path, 'utf8'), output); }
console.log(`instance-admin source ${cases.length} cases ${process.argv[2]} PASS`);
