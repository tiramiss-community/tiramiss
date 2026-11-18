/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import vm from 'node:vm';

const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { EntitySchema } = require('typeorm');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 }).toString();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(new URL('../../../../packages/backend-upstream/upstream-sync.json', import.meta.url)));
assert.equal(manifest.commit, pin);
const sources = new Map();
function source(path) {
	if (!sources.has(path)) sources.set(path, git('show', `${pin}:${path}`));
	return ts.createSourceFile(path, sources.get(path), ts.ScriptTarget.Latest, true);
}
function evaluate(code, globals = {}) {
	return vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), globals);
}
const corePath = 'packages/backend/src/core/chart/core.ts';
const core = source(corePath);
const klass = core.statements.find(ts.isClassDeclaration);
const methods = ['convertSchemaToColumnDefinitions', 'schemaToEntity'].map(name => {
	const member = klass.members.find(n => n.name?.getText(core) === name);
	assert(member, name);
	return member.getText(core);
});
const constants = ['COLUMN_PREFIX', 'UNIQUE_TEMP_COLUMN_PREFIX', 'COLUMN_DELIMITER', 'camelToSnake'].map(name => {
	const declaration = core.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(core) === name);
	assert(declaration, name);
	return `const ${declaration.getText(core)};`;
});
const Chart = evaluate(`${constants.join('\n')} class Chart { ${methods.join('\n')} } Chart;`, { EntitySchema });
const managementPath = 'packages/backend/src/core/chart/ChartManagementService.ts';
const management = source(managementPath);
const chartFiles = management.statements.filter(ts.isImportDeclaration).map(n => n.moduleSpecifier.text).filter(s => s.startsWith('./charts/'));
assert.equal(chartFiles.length, 12);
const charts = chartFiles.map(path => {
	const file = `packages/backend/src/core/chart/charts/entities/${posix.basename(path).replace(/\.js$/, '.ts')}`;
	const sf = source(file);
	const declarations = sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []);
	const value = name => declarations.find(n => n.name.getText(sf) === name).initializer.getText(sf);
	const name = evaluate(`(${value('name')})`);
	const schema = evaluate(`(${value('schema')})`);
	const entities = evaluate(`(${value('entity')})`, { Chart, name, schema });
	return { name, definition: file, schema: JSON.parse(JSON.stringify(schema)), entities: Object.fromEntries(Object.entries(entities).map(([span, entity]) => [span, entity.options])) };
});
source('packages/backend/src/core/chart/entities.ts');
source('packages/backend/src/postgres.ts');
// Mirror sync.mjs's dependency scan, including type imports: it rejects both.
const tree = new Set(git('ls-tree', '-r', '--name-only', pin, '--', 'packages/backend/src').trim().split('\n'));
const closure = new Set();
const external = new Set();
const queue = charts.map(c => c.definition);
while (queue.length) {
	const path = queue.shift();
	if (closure.has(path)) continue;
	closure.add(path);
	const text = source(path).text;
	for (const [, specifier] of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
		if (specifier.startsWith('.') || specifier.startsWith('@/')) {
			const dependency = (specifier.startsWith('@/') ? `packages/backend/src/${specifier.slice(2)}` : posix.normalize(posix.join(posix.dirname(path), specifier))).replace(/\.js$/, '.ts');
			assert(tree.has(dependency), `${path}: missing ${dependency}`);
			queue.push(dependency);
		} else if (!specifier.startsWith('node:')) {
			external.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
		}
	}
}
const paths = [...closure].sort();
const currentFiles = new Set(manifest.files.map(p => `packages/backend/${p}`));
const outside = paths.filter(p => !currentFiles.has(p));
const dependencyClosure = {
	files: paths.length,
	alreadySynced: paths.length - outside.length,
	outsideCurrentManifest: outside.length,
	outsideAllowedManagedPaths: paths.filter(p => !/^packages\/backend\/src\/(models\/.*\.ts|types\.ts)$/.test(p)),
	externalDependencies: [...external].sort(),
	undeclaredExternalDependencies: [...external].filter(p => !manifest.externalDependencies.includes(p)).sort(),
};
const inputs = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, gitBlob: git('rev-parse', `${pin}:${path}`).trim(), sha256: hash(bytes) }));
const output = JSON.stringify({ upstreamCommit: pin, extraction: 'Exact two static Chart methods and constants; literal definition initializers; actual TypeORM EntitySchema. No chart service execution.', inputs, dependencyClosure, charts }, null, 2) + '\n';
const target = new URL('./schema-manifest.json', import.meta.url);
assert(['--write', '--check'].includes(process.argv[2]));
if (process.argv[2] === '--write') writeFileSync(target, output);
else assert.equal(readFileSync(target, 'utf8'), output);
console.log(`chart-storage source: ${charts.length} series / ${charts.length * 2} tables; dependency closure ${paths.length} files ${process.argv[2]}`);
