/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = new URL('../../../../', import.meta.url);
const require = createRequire(process.env.SOURCE_PROBE_DEPENDENCY_ROOT ? `${process.env.SOURCE_PROBE_DEPENDENCY_ROOT}/package.json` : new URL('package.json', root));
const ts = require('typescript');
const revision = '8e07cf085adf7009583d234a208e30436f020e26';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const upstreamInputs = {};
function upstream(file) {
	const source = execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' });
	upstreamInputs[file] = hash(source);
	return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}
function method(file, name, args) {
	const source = upstream(file);
	const member = source.statements.find(ts.isClassDeclaration).members.find(node => node.name?.getText(source) === name);
	assert(member?.body);
	return vm.runInNewContext(ts.transpile(`(async function(${args}) ${member.body.getText(source)})`, { target: ts.ScriptTarget.ES2022 }), { Date, JSON });
}
const currentInputs = {};
function current(file, exported, globals = {}) {
	const source = readFileSync(new URL(file, root), 'utf8');
	currentInputs[file] = hash(source);
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replaceAll('export ', '');
	return vm.runInNewContext(ts.transpile(`${body}\n${exported};`, { target: ts.ScriptTarget.ES2022 }), { Date, JSON, ...globals });
}

// Parse all candidate files so a multiline call cannot escape the site inventory.
const candidates = execFileSync('git', ['grep', '-l', '-E', "'(deleteNote|updateRole)'", revision, '--', 'packages/backend/src'], { cwd: root, encoding: 'utf8' })
	.trim().split('\n').map(line => line.slice(revision.length + 1));
const sites = [];
for (const file of candidates) {
	const ast = upstream(file);
	function visit(node) {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'log'
			&& ts.isStringLiteral(node.arguments[1]) && ['deleteNote', 'updateRole'].includes(node.arguments[1].text)) {
			sites.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}:${node.arguments[1].text}`);
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
}
assert.equal(sites.length, 2);
assert(sites.some(line => line.startsWith('packages/backend/src/core/NoteDeleteService.ts:120:')));
assert(sites.some(line => line.startsWith('packages/backend/src/core/RoleService.ts:713:')));
const sourceLog = method('packages/backend/src/core/ModerationLogService.ts', 'log', 'moderator,type,info');
const sourceDelete = method('packages/backend/src/core/NoteDeleteService.ts', 'delete', 'user,note,quiet=false,deleter');
const sourceUpdate = method('packages/backend/src/core/RoleService.ts', 'update', 'role,params,moderator');
upstream('packages/backend/src/core/IdService.ts');
const append = current('packages/backend-next/src/platform/database/moderation-log.ts', 'appendModerationLog', { MiModerationLog: {} });
const appendDelete = current('packages/backend-next/src/platform/database/note-deleter.ts', 'appendNoteDeleteAudit', { appendModerationLog: append });
const appendRole = current('packages/backend-next/src/platform/database/role-update-audit.ts', 'appendRoleUpdateAudit', { appendModerationLog: append });
const occurredAtMs = Date.parse('2026-11-18T00:00:00Z');
const actor = { id: 'moderator' };
const author = { id: 'author', username: '名前', host: 'remote.example' };
const note = { id: 'note', userId: author.id, replyId: null, text: 'quote " and 日本語', cw: null, visibility: 'specified', localOnly: true,
	fileIds: ['file'], mentionedRemoteUsers: '[]', reactions: { ':emoji:': 2 }, reactionAndUserPairCache: ['user/like'], nested: { list: [null, true] } };
let stored;
let sampledTime;
const manager = { getRepository: () => ({ createQueryBuilder: () => {
	let row;
	const builder = { insert: () => builder, values: value => { row = value; return builder; },
		setParameter: (name, value) => { assert.equal(name, 'info'); row.info = JSON.parse(value); return builder; },
		execute: async () => { stored = json(row); } };
	return builder;
} }) };
const newId = time => { sampledTime = time; return 'audit-id'; };
const sourceRows = [];
const sourceIdArguments = [];
const logger = { moderationLogsRepository: { insert: async row => { sourceRows.push(json(row)); } }, idService: { gen: (...args) => { sourceIdArguments.push(args); return 'audit-id'; } } };
const calls = [];
let rejectDelete = false;
let rejectAuthor = false;
const deletion = {
	notesRepository: { delete: async () => { calls.push('delete'); if (rejectDelete) throw new Error('DELETE rejected'); } },
	usersRepository: { findOneByOrFail: async () => { calls.push('author'); if (rejectAuthor) throw new Error('author missing'); return author; } },
	searchService: { unindexNote: () => {} },
	moderationLogService: { log: (...args) => { calls.push('audit'); return sourceLog.apply(logger, args); } },
};
await sourceDelete.call(deletion, author, note, true, actor);
assert.deepEqual(calls, ['delete', 'author', 'audit']);
await appendDelete(manager, { snapshot: { id: note.id, userId: author.id, authorUsername: author.username, authorHost: author.host, auditNote: note }, actorId: actor.id, occurredAtMs }, newId);
assert.deepEqual(stored, sourceRows[0]);
assert.equal(sampledTime, occurredAtMs);
const deleteInfo = stored.info;
for (const deleter of [undefined, author]) await sourceDelete.call(deletion, author, note, true, deleter);
assert.equal(sourceRows.length, 1);
rejectDelete = true;
await assert.rejects(sourceDelete.call(deletion, author, note, true, actor), /DELETE rejected/);
rejectDelete = false;
rejectAuthor = true;
await assert.rejects(sourceDelete.call(deletion, author, note, true, actor), /author missing/);
assert.equal(sourceRows.length, 1);

const before = { id: 'role', name: 'before', updatedAt: new Date(occurredAtMs - 1000), lastUsedAt: new Date(occurredAtMs - 2000), policies: { unknown: { value: null } }, color: null };
const after = { ...before, name: 'after', updatedAt: new Date(occurredAtMs) };
const updates = [];
const role = { rolesRepository: { update: async () => updates.push('save'), findOneByOrFail: async () => after },
	globalEventService: { publishInternalEvent: () => updates.push('publish') },
	moderationLogService: { log: (...args) => { updates.push('audit'); return sourceLog.apply(logger, args); } } };
await sourceUpdate.call(role, before, { name: 'after' }, actor);
assert.deepEqual(updates, ['save', 'publish', 'audit']);
const snapshot = row => { const { updatedAt, lastUsedAt, ...fields } = row; return { ...fields, updatedAtMs: updatedAt.getTime(), lastUsedAtMs: lastUsedAt.getTime() }; };
await appendRole(manager, { roleId: before.id, actorId: actor.id, before: snapshot(before), after: snapshot(after), occurredAtMs }, newId);
assert.deepEqual(stored, sourceRows[1]);
assert.equal(sampledTime, occurredAtMs);
const roleInfo = stored.info;
assert.deepEqual(sourceIdArguments, [[], []]);
await sourceUpdate.call(role, before, {}, undefined);
assert.equal(sourceRows.length, 2);

// The source callers do not await the logger. A held insert cannot hold either method.
let release;
let pending;
const heldLog = { log: (...args) => {
	pending = sourceLog.call({ ...logger, moderationLogsRepository: { insert: () => new Promise(resolve => { release = resolve; }) } }, ...args);
	return pending;
} };
rejectAuthor = false;
await sourceDelete.call({ ...deletion, moderationLogService: heldLog }, author, note, true, actor);
assert.equal(typeof release, 'function'); release(); await pending;
await sourceUpdate.call({ ...role, moderationLogService: heldLog }, before, {}, actor);
assert.equal(typeof release, 'function'); release(); await pending;

const changedAuthor = { ...author, username: 'renamed-after-delete' };
await sourceDelete.call({ ...deletion, usersRepository: { findOneByOrFail: async () => changedAuthor } }, author, note, true, actor);
assert.equal(sourceRows.at(-1).info.noteUserUsername, changedAuthor.username);
assert.equal(deleteInfo.noteUserUsername, author.username);
console.log(JSON.stringify({ revision, provenance: 'literal-source-methods-with-repository-and-id-doubles', upstreamFullServerMeasured: false,
	sites, upstreamInputs, currentInputs, deleteInfo, roleInfo,
	boundaries: { sourceIdArguments: [[], []], nextIdArgument: occurredAtMs,
		authorLookupProjection: { sourcePostDeleteUsername: sourceRows.at(-1).info.noteUserUsername, nextPreDeleteSnapshotUsername: deleteInfo.noteUserUsername },
		authorLookupProjectionIsDoubleControlled: true },
	assertions: ['full finite deleteNote info matches the existing adapter/appender', 'actor and type match', 'role before/after dates serialize to ISO',
		'new appenders pass occurredAtMs to id generation', 'source delete succeeds before author lookup and log', 'source DELETE/author lookup failure omits audit',
		'source author/absent deleter and absent Role moderator omit audit', 'source callers return before held log insert completes'],
}, null, 2));
