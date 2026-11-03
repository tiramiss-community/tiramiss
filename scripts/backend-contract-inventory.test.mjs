/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractApiRegistry, validateApiCoverage, extractHttpRoutes, extractCases, extractActivities, extractSchedules, assignDomain, validateCatalog } from './backend-contract-inventory.mjs';

test('API registry uses exported names and ignores nearby tests and comments', () => {
	assert.deepEqual(extractApiRegistry(`
// export * as 'unused' from './endpoints/unused.js';
export * as 'users/show' from './endpoints/users/show.js';
export * as 'notes/create' from './endpoints/notes/create.js';
`), [
		{ name: 'users/show', source: 'packages/backend/src/server/api/endpoints/users/show.ts', line: 3 },
		{ name: 'notes/create', source: 'packages/backend/src/server/api/endpoints/notes/create.ts', line: 4 },
	]);
});

test('registry coverage rejects two aliases for one handler leaving another unregistered', () => {
	assert.doesNotThrow(() => validateApiCoverage([{ source: 'a.ts' }, { source: 'b.ts' }], ['a.ts', 'b.ts']));
	assert.throws(() => validateApiCoverage([{ source: 'a.ts' }, { source: 'a.ts' }], ['a.ts', 'b.ts']), /coverage/);
});

test('HTTP inventory keeps generic, dynamic, empty-token and constrained routes distinct', () => {
	const routes = extractHttpRoutes('server.ts', `
class Server {
 createServer(fastify) {
  fastify.get<{ Params: { id: string } }>('/notes/:id', { constraints: { apOrHtml: 'ap' } }, run);
  fastify.get('/notes/:id', { constraints: { apOrHtml: 'html' } }, run);
  fastify.all('/' + endpoint.name, run);
  fastify.route({ method: ['GET', 'HEAD'], url: '/files/:key', handler: run });
 }
 createTokenServer(fastify) { fastify.post('', run); }
}`);
	assert.equal(routes.length, 5);
	assert.deepEqual(routes.map(x => [x.method, x.path, x.scope]), [
		['GET', '/notes/:id', 'createServer'], ['GET', '/notes/:id', 'createServer'],
		['ALL', "'/' + endpoint.name", 'createServer'], ['GET,HEAD', '/files/:key', 'createServer'],
		['POST', '', 'createTokenServer'],
	]);
	assert.notEqual(routes[0].id, routes[1].id);
	assert.equal(routes[2].dynamic, true);
	assert.match(routes[0].constraints, /apOrHtml/);
});

test('switch inventory includes stream command aliases and relationship actions', () => {
	assert.deepEqual(extractCases(`class C { onMessage(type) { switch(type) {
case 'subNote': case 's': return subscribe(); case 'unfollow': return stop();
} } }`).map(x => [x.name, x.scope]), [['subNote', 'onMessage'], ['s', 'onMessage'], ['unfollow', 'onMessage']]);
});

test('HTTP route constants resolve only explicit string declarations', () => {
	const routes = extractHttpRoutes('server.ts', `const nodeinfoPath = '/nodeinfo/2.1';
class Server { createServer(fastify) { fastify.get(nodeinfoPath, run); fastify.get(runtimePath, run); } }`);
	assert.equal(routes[0].path, '/nodeinfo/2.1');
	assert.equal(routes[0].dynamic, false);
	assert.equal(routes[1].path, 'runtimePath');
	assert.equal(routes[1].dynamic, true);
});

test('AP and scheduled job discovery includes dispatch boundaries without executing source', () => {
	assert.deepEqual(extractActivities(`class C {
 performOneActivity(actor, activity) { if(isCreate(activity)) return create(); else if(isMove(activity)) return move(); }
 helper(activity) { return isLike(activity); }
}`).map(x => x.name), ['Create', 'Move']);
	assert.deepEqual(extractSchedules(`const REPEATABLE_SYSTEM_JOB_DEF = [
 { name: 'tickCharts', pattern: '55 * * * *' }, { name: 'clean', pattern: '0 0 * * *' }
];`).map(x => [x.name, x.pattern]), [['tickCharts', '55 * * * *'], ['clean', '0 0 * * *']]);
});

test('domain assignment uses the most specific explicit rule and rejects gaps or ties', () => {
	const domains = [
		{ id: 'admin', apiPrefixes: ['admin/'] },
		{ id: 'roles', apiPrefixes: ['admin/roles/'], apiNames: ['roles'] },
	];
	assert.equal(assignDomain('admin/roles/update', domains), 'roles');
	assert.equal(assignDomain('roles', domains), 'roles');
	assert.throws(() => assignDomain('new-api', domains), /Unassigned/);
	assert.throws(() => assignDomain('roles', [...domains, { id: 'other', apiNames: ['roles'] }]), /Ambiguous/);
});

function fixture() {
	return {
		catalog: { contracts: [{ id: 'api:x', domain: 'x', source: 'upstream.ts', line: 1, status: 'not_implemented' }] },
		domains: [{ id: 'x', issue: 129, scope: 'x', persistence: ['DB'], effects: ['none'], implementation: [], verification: [], differences: [] }],
		upstreamFiles: new Set(['upstream.ts']), implementationFiles: new Set(['new.ts', 'test.ts']),
	};
}

test('catalog rejects duplicate contracts, unowned domains and broken source references', () => {
	const f = fixture();
	assert.doesNotThrow(() => validateCatalog(f.catalog, f.domains, f));
	f.catalog.contracts.push({ ...f.catalog.contracts[0] });
	assert.throws(() => validateCatalog(f.catalog, f.domains, f), /Duplicate/);
	f.catalog.contracts.pop();
	f.domains[0].issue = null;
	assert.throws(() => validateCatalog(f.catalog, f.domains, f), /issue/);
	f.domains[0].issue = 129;
	f.domains[0].upstreamReferences = ['missing.ts'];
	assert.throws(() => validateCatalog(f.catalog, f.domains, f), /source/);
	f.domains[0].upstreamReferences = ['upstream.ts'];
	f.catalog.contracts[0].source = 'missing.ts';
	assert.throws(() => validateCatalog(f.catalog, f.domains, f), /source/);
});

test('verified or partial status requires existing implementation and test evidence', () => {
	const f = fixture();
	const contract = f.catalog.contracts[0];
	contract.status = 'verified';
	assert.throws(() => validateCatalog(f.catalog, f.domains, f), /evidence/);
	contract.implementation = ['new.ts'];
	contract.verification = ['test.ts'];
	assert.doesNotThrow(() => validateCatalog(f.catalog, f.domains, f));
	contract.verification = ['missing-test.ts'];
	assert.throws(() => validateCatalog(f.catalog, f.domains, f), /reference/);
});
