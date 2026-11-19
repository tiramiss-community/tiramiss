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
const root = new URL('../../../../', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root });
const manifest = [];
function source(path) {
	const bytes = git('show', `${pin}:${path}`);
	manifest.push({ path, gitBlob: git('rev-parse', `${pin}:${path}`).toString().trim(), sha256: sha(bytes) });
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
class ApiError extends Error {
	constructor(meta) { super(meta.message); this.code = meta.code; this.id = meta.id; }
}
const context = { ApiError, ms: () => 3600000, Date: { now: () => 1700000000000 }, ACHIEVEMENT_TYPES: ['myNoteFavorited1'] };
const evaluate = text => vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), context);
function method(path, name) {
	const sf = source(path);
	const member = sf.statements.find(ts.isClassDeclaration).members.find(n => n.name?.getText(sf) === name);
	assert(member?.body, name);
	return evaluate(`(async function(${member.parameters.map(p => p.getText(sf)).join(',')}) ${member.body.getText(sf)})`);
}
const visibility = method('packages/backend/src/core/entities/NoteEntityService.ts', 'isVisibleForMe');
const achievement = method('packages/backend/src/core/AchievementService.ts', 'create');
const state = source('packages/backend/src/server/api/endpoints/notes/state.ts');
const stateCtor = state.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
const stateCallback = stateCtor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression.arguments[2];
const readState = evaluate(`(async function(${stateCallback.parameters.map(p => p.getText(state)).join(',')}) ${stateCallback.body.getText(state)})`);
const handlers = {};
const access = {};
const ajv = new Ajv();
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
for (const operation of ['favorites/create', 'favorites/delete', 'thread-muting/create', 'thread-muting/delete']) {
	const sf = source(`packages/backend/src/server/api/endpoints/notes/${operation}.ts`);
	const vars = sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []);
	const meta = evaluate(`(${vars.find(n => n.name.getText(sf) === 'meta').initializer.getText(sf)})`);
	const param = evaluate(`(${vars.find(n => n.name.getText(sf) === 'paramDef').initializer.getText(sf)})`);
	const ctor = sf.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
	const callback = ctor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression.arguments[2];
	// meta is lexical in the real endpoint; each evaluator context gets its own immutable meta.
	const fn = vm.runInNewContext(ts.transpile(`(async function(${callback.parameters.map(p => p.getText(sf)).join(',')}) ${callback.body.getText(sf)})`, { target: ts.ScriptTarget.ES2022 }), { ApiError, meta });
	handlers[operation] = { fn, validate: ajv.compile(param) };
	access[operation] = { requireCredential: meta.requireCredential, kind: meta.kind, prohibitMoved: meta.prohibitMoved ?? false, limit: meta.limit ?? null };
}
source('packages/backend/src/models/NoteFavorite.ts');
source('packages/backend/src/models/NoteThreadMuting.ts');
source('packages/backend/src/server/api/GetterService.ts');
source('packages/backend/src/core/NotificationService.ts');
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const cases = [];
for (const item of corpus.cases) {
	const note = item.note === null ? null : { id: 'targetnote', threadId: null, userId: 'author', userHost: null, visibility: 'public', visibleUserIds: [], mentions: [], replyUserId: null, ...item.note };
	let favorites = structuredClone(item.favorites ?? []);
	let mutings = structuredClone(item.mutings ?? []);
	let achievements = structuredClone(item.achievements ?? []);
	const notifications = [];
	const pending = [];
	const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
	const repository = (read, write) => ({
		async exists({ where }) { return read().some(row => matches(row, where)); },
		async findOneBy(where) { return read().find(row => matches(row, where)) ?? null; },
		async insert(row) { if (item.fail === 'insert') throw Error('insert unavailable'); write([...read(), { ...row }]); },
		async delete(where) { if (item.fail === 'delete') throw Error('delete unavailable'); write(read().filter(row => typeof where === 'string' ? row.id !== where : !matches(row, where))); },
		async count({ where }) { return read().filter(row => matches(row, where)).length; },
	});
	const favRepo = repository(() => favorites, rows => { favorites = rows; });
	const muteRepo = repository(() => mutings, rows => { mutings = rows; });
	const services = {
		noteFavoritesRepository: favRepo, noteThreadMutingsRepository: muteRepo,
		getterService: { async getNote() { if (!note) throw { id: '9725d0ce-ba28-4dde-95a7-2cbb2c15de24' }; return note; } },
		idService: { gen: () => corpus.newId },
		noteEntityService: { isVisibleForMe: (note, userId) => visibility.call({ followingsRepository: { count: async () => item.following ? 1 : 0 }, usersRepository: { findOneByOrFail: async () => ({ host: null }) } }, note, userId) },
		achievementService: { create(userId, type) {
			const task = achievement.call({ userProfilesRepository: {
				async findOneByOrFail() { if (item.fail === 'achievement') throw Error('achievement unavailable'); return { achievements }; },
				async update(_id, change) { achievements = change.achievements; },
			}, notificationService: { createNotification(id, type, data) { if (item.notificationMode !== 'never') notifications.push({ userId: id, type, ...data }); } } }, userId, type).catch(error => ({ error: error.message }));
			pending.push(task);
		} },
	};
	const steps = [];
	for (const step of item.steps) {
		const handler = handlers[step.operation];
		let error;
		try {
			const input = { noteId: 'targetnote', ...step.input };
			if (!handler.validate(input)) error = { code: 'INVALID_PARAM' };
			else await handler.fn.call(services, input, { id: item.actorId ?? 'viewer' });
		} catch (caught) {
			assert.notEqual(caught.name, 'ReferenceError');
			error = caught.code ? { code: caught.code, id: caught.id } : { message: caught.message };
		}
		await Promise.all(pending);
		const reads = [];
		if (note) {
			for (const userId of [item.actorId ?? 'viewer', 'other']) {
				const value = await readState.call({ notesRepository: { findOneByOrFail: async () => note }, noteFavoritesRepository: favRepo, noteThreadMutingsRepository: muteRepo }, { noteId: note.id }, { id: userId });
				reads.push({ userId, ...value });
			}
		}
		steps.push({ ...(error ? { error } : {}), favorites: structuredClone(favorites), mutings: structuredClone(mutings), achievements: structuredClone(achievements), notifications: structuredClone(notifications), reads });
	}
	cases.push({ id: item.id, steps });
}
const output = JSON.stringify({ upstreamCommit: pin, manifest, corpusSha256: sha(corpusBytes), doubles: corpus.doubles, access, cases }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') writeFileSync(target, output);
else { assert.equal(process.argv[2], '--check'); assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`note-personal-state fixed source: ${cases.length} cases ${process.argv[2]}`);
