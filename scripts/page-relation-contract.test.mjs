/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPageReadInput, projectUserMemoInput } from './notes-pagination-evidence.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const states = {
  "packages/backend-next/src/composition/http-app.ts": {
    "base": "70ad0cbb84ddcefaa2e6fc9ac79e1a0c769707537ed39d200d7340b98c0657a6",
    "page": "2e8d012d59c1c0ca2920eefccc7a542ab73de8a15dc82a211d3ab0a49beabe26",
    "relation": "5f881c86b179744c73be9d1c7b668a2227747b9cf98a8a7ecfbb7b2dc2b68264",
    "combined": "350bbc6ff8951287282253c391a80d9be2c1d4d6fbd5dce6149b51c00c3f386f"
  },
  "packages/backend-next/test/unit/composition/http-app.test.ts": {
    "base": "cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2",
    "page": "f6e205b59d56cd23cd835ec57e80f0fafbedc708a75284cd0af5f1c8bddb4e8f",
    "relation": "734cee44fd1181a8c77fa08bf05623e41b28478b0f4eea8a2d2f8689c7632899",
    "combined": "f107b9b110e85b050fb1ff3d2ce92d6b3cf973911fcf43bea0c4b805f63a765b"
  }
};
function change(text, before, after) {
	assert.equal(text.split(before).length, 2, 'one exact registration anchor');
	return text.replace(before, after);
}
function withRelation(path, text) {
	if (path.includes('/src/')) {
		text = change(text, "import { createUserMemoHttp }", "import { createUserRelationHttp } from './user-relation-http.js';\nimport { createUserMemoHttp }");
		return change(text, "\t\t.route('/', createUserMemoHttp(resources, config))\n", "\t\t.route('/', createUserMemoHttp(resources, config))\n\t\t.route('/', createUserRelationHttp(resources))\n");
	}
	return change(text, "'/api/users/update-memo',", "'/api/users/update-memo', '/api/users/relation',");
}
function withPage(path, text) {
	if (path.includes('/src/')) {
		text = change(text, "import { createUserMemoHttp } from './user-memo-http.js';\n", "import { createUserMemoHttp } from './user-memo-http.js';\nimport { createPagesHttp } from './pages-http.js';\n");
		text = change(text, "\tconst folders = createDriveFoldersHttp(resources, config);\n", "\tconst folders = createDriveFoldersHttp(resources, config);\n\tconst pages = createPagesHttp(resources, config);\n");
		text = change(text, "\t\t.route('/', createDriveFilesHttp(resources, config))\n", "\t\t.route('/', createDriveFilesHttp(resources, config))\n\t\t.route('/', pages.app)\n");
		return change(text, "registerHttpAppWork(app, folders.idle)", "registerHttpAppWork(app, async () => {\n\t\tawait Promise.all([folders.idle(), pages.idle()]);\n\t})");
	}
	return change(text, "'/api/admin/drive/show-file',", "'/api/admin/drive/show-file', '/api/pages/show',");
}
for (const [path, identity] of Object.entries(states)) {
	test(`known Page, Relation and combined registration preserve their exact predecessor: ${path}`, () => {
		let base = projectPageReadInput(path, readFileSync(new URL('../' + path, import.meta.url))).toString();
		if (hash(base) === identity.relation) {
			for (const addition of path.includes('/src/') ? ["import { createUserRelationHttp } from './user-relation-http.js';\n", "\t\t.route('/', createUserRelationHttp(resources))\n"] : [", '/api/users/relation'"]) base = change(base, addition, '');
		}
		assert.equal(hash(base), identity.base);
		const variants = { page: withPage(path, base), relation: withRelation(path, base), combined: withRelation(path, withPage(path, base)) };
		for (const [name, bytes] of Object.entries(variants)) {
			assert.equal(hash(bytes), identity[name]);
			const projected = projectPageReadInput(path, Buffer.from(bytes));
			assert.equal(hash(projected), name === 'page' ? identity.base : identity.relation);
			assert.equal(hash(projectUserMemoInput(path, Buffer.from(bytes))), path.includes('/src/') ? 'e8851b4ec5bba14758c315e98368105051463cb7cba8d26b3c18ad332ff381cc' : 'fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e');
			for (const changed of [bytes + '\n', bytes.replace('createBackendHttpApp', 'changedBackendHttpApp')]) {
				assert.throws(() => projectPageReadInput(path, Buffer.from(changed)), /measured current input drift/);
				assert.throws(() => projectUserMemoInput(path, Buffer.from(changed)), /measured current input drift/);
			}
		}
	});
}

test('declared UserMemo-only bytes pass the Page step and reach the existing exact memo predecessor', () => {
	const path = 'packages/backend-next/test/unit/composition/http-app.test.ts';
	let memo = projectPageReadInput(path, readFileSync(new URL('../' + path, import.meta.url))).toString();
	if (hash(memo) === states[path].relation) memo = change(memo, ", '/api/users/relation'", '');
	assert.equal(hash(memo), states[path].base);
	memo = change(memo, "'/api/notes/polls/recommendation', ", '');
	memo = change(memo, "'notes/polls/recommendation', ", '');
	const actual = Buffer.from(memo);
	assert.equal(hash(actual), '43aab6cd144b8d0937fca5bec41322d2bed0125c1f94118e7bebb4437d901bda');
	assert.equal(projectPageReadInput(path, actual), actual);
	assert.equal(hash(projectUserMemoInput(path, actual)), 'a2f030dbfecfa3644a09d1d1aca81a8693ffec7dbad1bc3ceac9894fb46be5eb');
	for (const changed of [memo + '\n', memo.replace('users/update-memo', 'users/changed-memo')]) {
		assert.throws(() => projectPageReadInput(path, Buffer.from(changed)), /measured current input drift/);
		assert.throws(() => projectUserMemoInput(path, Buffer.from(changed)), /measured current input drift/);
	}
});
