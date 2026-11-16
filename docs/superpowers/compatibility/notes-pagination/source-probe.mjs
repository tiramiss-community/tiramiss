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
assert(root, 'Set BACKEND_NEXT_UPSTREAM_PATH to pinned Git objects');
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const paths = ['packages/backend/src/core/QueryService.ts', 'packages/backend/src/server/api/endpoints/notes.ts', 'packages/backend/src/core/entities/UserEntityService.ts'];
const sources = paths.map(path => execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8' }));
const trees = sources.map((source, i) => ts.createSourceFile(paths[i], source, ts.ScriptTarget.Latest, true));
const compile = (source, sandbox = {}) => vm.runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022 }), sandbox);
const queryClass = trees[0].statements.find(ts.isClassDeclaration);
function method(name) {
	const node = queryClass.members.find(member => member.name?.getText(trees[0]) === name);
	return compile(`(function(${node.parameters.map(p => p.getText(trees[0])).join(',')}) ${node.body.getText(trees[0])})`);
}
const pagination = method('makePaginationQuery');
const ugc = method('generateUgcVisibilityQueryForVisitor');
let callback;
let schema;
function visit(node) {
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
		const arrow = node.arguments[2];
		callback = compile(`(async function(${arrow.parameters.map(p => p.getText(trees[1])).join(',')}) ${arrow.body.getText(trees[1])})`);
	}
	if (ts.isVariableDeclaration(node) && node.name.getText(trees[1]) === 'paramDef') schema = compile(`(${node.initializer.getText(trees[1])})`);
	ts.forEachChild(node, visit);
}
visit(trees[1]);
const inputs = [{}, { sinceId: 'b' }, { untilId: 'd' }, { sinceId: 'b', untilId: 'd' }, { sinceId: 'b', untilDate: 20 }, { untilId: 'd', sinceDate: 10 }, { sinceId: 'b', untilId: 'd', sinceDate: 10, untilDate: 20 }, { sinceDate: 10 }, { untilDate: 20 }, { sinceDate: 10, untilDate: 20 }, { sinceDate: 0, untilDate: 0 }, { sinceDate: -1 }, { sinceDate: null, untilDate: 20 }];
const cursors = inputs.map(input => {
	const plan = {};
	const q = { alias: 'note', andWhere: (_, values) => { Object.assign(plan, values); return q; }, orderBy: (_, order) => { plan.order = order; return q; } };
	pagination.call({ idService: { gen: date => `date${date}` } }, q, input.sinceId, input.untilId, input.sinceDate, input.untilDate);
	return { input, plan };
});
const conditions = [];
for (const guest of [false, true]) for (const visibility of ['all', 'local', 'none']) for (const value of [undefined, false, true]) {
	const where = [];
	let packedArguments;
	const q = { alias: 'note', andWhere: condition => { where.push(condition); return q; }, orderBy: () => q, innerJoinAndSelect: () => q, leftJoinAndSelect: () => q, limit: () => q, getMany: async () => [] };
	const input = { local: value ?? false, reply: value, renote: value, withFiles: value, poll: value, limit: 10 };
	const service = { meta: { ugcVisibilityForVisitor: visibility }, makePaginationQuery: pagination, generateUgcVisibilityQueryForVisitor: ugc };
	await callback.call({ notesRepository: { createQueryBuilder: () => q }, queryService: service, noteEntityService: { packMany: (...args) => { packedArguments = args.length; return []; } } }, input, guest ? null : { id: 'viewer' });
	conditions.push({ guest, visibility, input, where, packedArguments });
}
if (process.argv.includes('--pg')) {
	const { sourceNotesDatabase } = await import('../../../../packages/backend-next/test/helpers/notes-list-source-database.mjs');
	const request = JSON.parse(readFileSync(0, 'utf8'));
	const { database: db, notesRepository, usersRepository } = await sourceNotesDatabase(request.database);
	const userMethod = trees[2].statements.find(ts.isClassDeclaration).members.find(member => member.name?.getText(trees[2]) === 'packMany');
	const prefixEnd = userMethod.body.statements.findIndex(statement => statement.getText(trees[2]).startsWith('const _userIds'));
	const completeUsers = compile(`(async function(users) { ${userMethod.body.statements.slice(0, prefixEnd).map(statement => statement.getText(trees[2])).join('\n')} return _users; })`, { In: require('typeorm').In });
	try {
		const results = [];
		for (const item of request.cases) {
			const service = { meta: { ugcVisibilityForVisitor: item.ugc }, idService: { gen: date => item.dateIds[String(date)] }, makePaginationQuery: pagination, generateUgcVisibilityQueryForVisitor: ugc };
			const ids = await callback.call({ notesRepository, queryService: service, noteEntityService: { packMany: async notes => {
				if (!request.snapshot) return notes.map(note => note.id);
				if (request.changeUserAfterSelection) await usersRepository.update(request.changeUserAfterSelection.id, request.changeUserAfterSelection.patch);
				const users = await completeUsers.call({ usersRepository }, [...notes.map(note => note.user ?? note.userId), ...notes.map(note => note.replyUserId).filter(id => id != null), ...notes.map(note => note.renoteUserId).filter(id => id != null)]);
				const byId = new Map(users.map(user => [user.id, user]));
				return notes.map(note => ({ id: note.id, text: note.text, user: { id: note.user.id, name: byId.get(note.userId).name }, reply: note.reply ? { id: note.reply.id, text: note.reply.text } : null, renote: note.renote ? { id: note.renote.id, text: note.renote.text } : null }));
			} } }, { local: false, limit: 10, ...item.input }, item.authenticated ? { id: 'viewer' } : null);
			results.push(ids);
		}
		process.stdout.write(JSON.stringify(results));
	} finally {
		await db.destroy();
	}
} else {
	const result = { upstreamRevision: revision, inputs: paths.map((path, i) => ({ path, sha256: createHash('sha256').update(sources[i]).digest('hex') })), scope: 'Literal QueryService pagination/guest-UGC methods and notes endpoint callback/schema; query recorder and packMany double, not upstream server or packer.', schema, cursors, conditions };
	const output = new URL('./observations.json', import.meta.url);
	if (process.argv.includes('--write')) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
	else assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(readFileSync(output, 'utf8')));
	console.log(`PASS: ${cursors.length} cursor and ${conditions.length} notes-condition observations`);
}
