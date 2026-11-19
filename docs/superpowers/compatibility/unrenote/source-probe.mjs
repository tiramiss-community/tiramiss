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
import { fileURLToPath } from 'node:url';

const revision = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const paths = ['packages/backend/src/server/api/endpoints/notes/unrenote.ts', 'packages/backend/src/core/NoteDeleteService.ts', 'packages/backend/src/misc/is-renote.ts'];
const sources = paths.map(path => execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8' }));
const identity = sources.map((source, index) => ({ revision, path: paths[index], sha256: createHash('sha256').update(source).digest('hex') }));
const compile = (source, sandbox = {}) => vm.runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022 }), sandbox);
const trees = sources.map((source, i) => ts.createSourceFile(paths[i], source, ts.ScriptTarget.Latest, true));
let callbackText;
let deletionText;
let schema;
let meta;
const predicates = {};
function visit(node, tree, index) {
	if (index === 0 && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
		const arrow = node.arguments[2];
		callbackText = `(async function(${arrow.parameters.map(p => p.getText(tree)).join(',')}) ${arrow.body.getText(tree)})`;
	}
	if (index === 0 && ts.isVariableDeclaration(node) && ['paramDef', 'meta'].includes(node.name.getText(tree))) {
		const value = compile(`(${node.initializer.getText(tree)})`, { ms: value => value === '1hour' ? 3600000 : 1000 });
		if (node.name.getText(tree) === 'paramDef') schema = value;
		else meta = value;
	}
	if (index === 1 && ts.isMethodDeclaration(node) && node.name.getText(tree) === 'delete') {
		deletionText = `(async function(${node.parameters.map(p => p.getText(tree)).join(',')}) ${node.body.getText(tree)})`;
	}
	if (index === 2 && ts.isFunctionDeclaration(node)) {
		predicates[node.name.text] = compile(`(function(${node.parameters.map(p => p.getText(tree)).join(',')}) ${node.body.getText(tree)})`, predicates);
	}
	ts.forEachChild(node, child => visit(child, tree, index));
}
trees.forEach((tree, i) => visit(tree, tree, i));
assert(callbackText && deletionText && schema && meta);
if (!process.argv.includes('--pg')) {
	const result = JSON.parse(JSON.stringify({ identity, schema, meta, scope: 'Literal endpoint callback and NoteDeleteService.delete; PG mode executes real selection/decrement/delete in a rolled-back transaction. API gate, stream/charts/search and AP renderer/delivery are doubles; not a full upstream server.' }));
	const path = new URL('./source-observations.json', import.meta.url);
	if (process.argv.includes('--write')) writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
	else assert.deepEqual(result, JSON.parse(readFileSync(path, 'utf8')));
	console.log('PASS: pinned unrenote endpoint/deletion identities/schema/meta');
} else {
	const request = JSON.parse(readFileSync(0, 'utf8'));
	const { sourceNotesDatabase } = await import('../../../../packages/backend-next/test/helpers/notes-list-source-database.mjs');
	const { database } = await sourceNotesDatabase(request.database);
	const runner = database.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	try {
		const notes = runner.manager.getRepository('MiNote');
		const users = runner.manager.getRepository('MiUser');
		const events = [];
		const deletion = compile(deletionText, { ...predicates, Date });
		const service = {
			config: { url: 'http://example.test' }, meta: {}, notesRepository: notes, usersRepository: users,
			globalEventService: { publishNoteStream: note => events.push({ id: note.id, kind: 'stream' }) },
			userEntityService: { isLocalUser: user => user.host === null, isRemoteUser: user => user.host !== null },
			apRendererService: {
				addContext: value => value, renderUndo: () => ({ type: 'Undo' }), renderAnnounce: () => ({}),
				renderDelete: () => ({ type: 'Delete' }), renderTombstone: () => ({}),
			},
			deliverToConcerned: (_user, note, activity) => events.push({ id: note.id, kind: activity.type }),
			notesChart: { update: note => events.push({ id: note.id, kind: 'charts' }) },
			perUserNotesChart: { update: () => {} },
			searchService: { unindexNote: note => events.push({ id: note.id, kind: 'search' }) },
		};
		class ApiError extends Error {
			constructor(error) { super(error.message); Object.assign(this, error); }
		}
		const callback = compile(callbackText, { ApiError, meta });
		const observations = [];
		for (const input of request.inputs) {
			const pending = [];
			const selected = [];
			let release;
			const gate = new Promise(resolve => { release = resolve; });
			let completed = 0;
			let response;
			try {
				await callback.call({
					notesRepository: notes, usersRepository: users,
					getterService: { getNote: async id => {
						const note = await notes.findOneBy({ id });
						if (note === null) { throw { id: '9725d0ce-ba28-4dde-95a7-2cbb2c15de24' }; }
						return note;
					} },
					noteDeleteService: { delete: (user, note) => {
						selected.push(note.id);
						const task = gate.then(() => deletion.call(service, user, note)).then(() => { completed++; });
						pending.push(task);
						return task;
					} },
				}, { noteId: input.noteId }, { id: input.userId });
				response = { status: 204, body: null };
			} catch (error) {
				response = { status: 400, body: { error: { message: error.message, code: error.code, id: error.id, kind: 'client' } } };
			}
			const nonWaiting = selected.length === 0 || completed === 0;
			release();
			await Promise.all(pending);
			observations.push({ response, selected: selected.sort(), nonWaiting });
		}
		const rows = await notes.find({ order: { id: 'ASC' } });
		process.stdout.write(JSON.stringify({ identity, observations, events, rows: rows.map(row => ({ id: row.id, repliesCount: row.repliesCount, renoteCount: row.renoteCount })) }));
	} finally {
		await runner.rollbackTransaction(); await runner.release(); await database.destroy();
	}
}
