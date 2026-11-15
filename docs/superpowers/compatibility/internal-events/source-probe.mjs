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
assert(root, 'Set BACKEND_NEXT_UPSTREAM_PATH to pinned upstream checkout');
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const ts = require('typescript');
const inputs = {};
function method(name, member) {
	const path = `packages/backend/src/core/${name}.ts`;
	const source = execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8' });
	inputs[path] = createHash('sha256').update(source).digest('hex');
	const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const node = ast.statements.find(ts.isClassDeclaration).members.find(n => n.name?.getText(ast) === member);
	assert(node?.body, member);
	const parameters = node.parameters.map(p => p.name.getText(ast)).join(',');
	return vm.runInNewContext(ts.transpile(`(async function(${parameters}) ${node.body.getText(ast)})`, { target: ts.ScriptTarget.ES2022 }), { Date });
}
const publish = method('GlobalEventService', 'publish');
const internal = method('GlobalEventService', 'publishInternalEvent');
const webhookReceive = method('UserWebhookService', 'onMessage');
const antennaReceive = method('AntennaService', 'onRedisMessage');
const roleReceive = method('RoleService', 'onMessage');
const hook = { id: 'hook', userId: 'owner', url: 'https://hook.test', secret: '', active: true, on: ['note'] };
const antenna = { id: 'antenna', userId: 'owner', src: 'all', userListId: null, users: [], keywords: [], excludeKeywords: [], caseSensitive: false, excludeBots: false, withReplies: true, withFile: false, isActive: true, localOnly: false, excludeNotesInSensitiveChannel: false };
const role = { id: 'role', target: 'manual', condFormula: {}, policies: {}, isAdministrator: false, isModerator: false };
const assignment = { id: 'assignment', userId: 'owner', roleId: 'role', expiresAt: null };
const steps = [
	['webhookCreated', hook], ['webhookUpdated', { ...hook, secret: 'updated' }], ['webhookUpdated', { ...hook, active: false }], ['webhookUpdated', hook], ['webhookDeleted', hook],
	['antennaCreated', antenna], ['antennaUpdated', { ...antenna, withReplies: false }], ['antennaUpdated', { ...antenna, id: 'another' }], ['antennaDeleted', antenna],
	['roleCreated', role], ['roleUpdated', { ...role, isAdministrator: true }], ['roleDeleted', role], ['userRoleAssigned', assignment], ['userRoleUnassigned', assignment], ['policiesUpdated', { canInvite: false }],
];
const state = { activeWebhooks: [], antennas: [], roles: [], assignments: [] };
const cache = key => ({ get: () => state[key], set: value => { state[key] = value; } });
const roleState = { rolesCache: cache('roles'), roleAssignmentByUserIdCache: { get: () => state.assignments, set: (_, value) => { state.assignments = value; } } };
const projection = value => JSON.parse(JSON.stringify(value));
const observations = [];
for (const [type, body] of steps) {
	let envelope;
	const publication = { config: { host: 'source.test:444' }, redisForPub: { publish: (topic, payload) => { envelope = { topic, payload: JSON.parse(payload) }; } }, publish: (...args) => publish.apply(publication, args) };
	await internal.call(publication, type, body);
	assert.equal(envelope.topic, 'source.test:444');
	await webhookReceive.call(state, envelope.topic, JSON.stringify(envelope.payload));
	await antennaReceive.call(state, envelope.topic, JSON.stringify(envelope.payload));
	await roleReceive.call(roleState, envelope.topic, JSON.stringify(envelope.payload));
	observations.push({ type, envelope, expected: {
		hooks: projection(state.activeWebhooks.map(({ id, secret, on }) => ({ id, secret, on }))),
		antennas: projection(state.antennas.map(({ id, withReplies }) => ({ id, withReplies }))),
		roles: projection(state.roles.map(({ id, isAdministrator }) => ({ id, isAdministrator }))),
		assignments: projection(state.assignments.map(({ id, userId, roleId }) => ({ id, userId, roleId }))),
	} });
}
const result = { upstreamRevision: revision, methodExtraction: 'literal method bodies with cache and Redis publication doubles; finite warm-cache projection, not live upstream server', inputs, observations };
const output = new URL('./source-observations.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
else assert.deepEqual(result, JSON.parse(readFileSync(output, 'utf8')));
console.log(`PASS: ${observations.length} pinned source event projections`);
