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
const { Brackets, In } = require('typeorm');
const path = 'packages/backend/src/server/api/endpoints/notes/polls/recommendation.ts';
const source = execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8' });
const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const compile = (text, sandbox = {}) => vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), sandbox);
let callbackText;
let schema;
let meta;
function visit(node) {
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
		const arrow = node.arguments[2];
		callbackText = `(async function(${arrow.parameters.map(p => p.getText(tree)).join(',')}) ${arrow.body.getText(tree)})`;
	}
	if (ts.isVariableDeclaration(node) && ['paramDef', 'meta'].includes(node.name.getText(tree))) {
		const value = compile(`(${node.initializer.getText(tree)})`);
		if (node.name.getText(tree) === 'paramDef') schema = value;
		else meta = value;
	}
	ts.forEachChild(node, visit);
}
visit(tree);
assert(callbackText && schema && meta);
const identity = { revision, path, sha256: createHash('sha256').update(source).digest('hex') };
if (process.argv.includes('--pg')) {
	const request = JSON.parse(readFileSync(0, 'utf8'));
	const { sourceNotesDatabase } = await import('../../../../packages/backend-next/test/helpers/notes-list-source-database.mjs');
	const { database: db, notesRepository } = await sourceNotesDatabase(request.database);
	const FixedDate = class extends Date { constructor(...args) { super(...(args.length ? args : [request.now])); } };
	const callback = compile(callbackText, { Brackets, In, Date: FixedDate });
	try {
		const observations = [];
		for (const input of request.inputs) {
			let packed = null;
			try {
				const ids = await callback.call({ notesRepository,
					pollsRepository: db.getRepository('MiPoll'), pollVotesRepository: db.getRepository('MiPollVote'), mutingsRepository: db.getRepository('MiMuting'),
					noteEntityService: { packMany: (notes, me, options) => { packed = { viewerId: me.id, options }; return notes.map(note => note.id); } },
				}, { limit: 10, offset: 0, excludeChannels: false, ...input }, { id: request.viewerId });
				observations.push({ input, ids, packed });
			} catch (error) {
				observations.push({ input, error: error.message });
			}
		}
		process.stdout.write(JSON.stringify({ identity, now: request.now, observations }));
	} finally {
		await db.destroy();
	}
} else {
	const result = JSON.parse(JSON.stringify({ identity, schema, meta, scope: 'Literal pinned endpoint callback/schema/meta. PG mode uses real QueryBuilder/PG and a packMany ID double, not upstream full server or packer.' }));
	const output = new URL('./source-observations.json', import.meta.url);
	if (process.argv.includes('--write')) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
	else assert.deepEqual(result, JSON.parse(readFileSync(output, 'utf8')));
	console.log('PASS: pinned recommendation schema/meta/source identity');
}
