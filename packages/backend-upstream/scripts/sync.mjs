/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const header =
	'/*\n * SPDX-FileCopyrightText: syuilo and misskey-project\n * SPDX-License-Identifier: AGPL-3.0-only\n */\n';

function safePath(path) {
	if (
		!/^(src\/models\/.*\.ts|migration\/[^/]+\.js|exports\/(entities|migrations)\.ts)$/.test(path) ||
		path.split('/').includes('..')
	) throw new Error(`Invalid managed path: ${path}`);
	return path;
}

export async function sync({ repository, destination, check = false }) {
	const manifest = JSON.parse(await readFile(resolve(destination, 'upstream-sync.json'), 'utf8'));
	if (
		!/^[a-f0-9]{40}$/.test(manifest.commit) ||
		manifest.generatorVersion !== 1 ||
		manifest.migrationDirectory !== 'migration'
	) throw new Error('Invalid sync manifest');
	const git = (...args) => execFileSync('git', args, { cwd: repository, maxBuffer: 32 * 1024 * 1024 });
	// 作業ツリーからコピーすると未コミットの変更まで混ざるため、固定 SHA の Git オブジェクトを読む。
	const migrationFiles = git('ls-tree', '-r', '--name-only', manifest.commit, '--', 'packages/backend/migration')
		.toString()
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((p) => p.replace('packages/backend/', ''))
		.sort();
	const files = [...manifest.files, ...migrationFiles];
	const expected = new Map();
	for (const file of files) {
		safePath(file);
		expected.set(file, git('show', `${manifest.commit}:packages/backend/${file}`));
	}
	const allowed = new Set(files);
	for (const [file, content] of expected) {
		const source = content.toString();
		// 対象はリテラル指定の import を使うソースに限る。依存を自動追跡して旧サービス層まで
		// 取り込まないよう、対象の追加は manifest で明示するまで拒否する。
		const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map(
			(m) => m[1],
		);
		for (const specifier of imports) {
			if (specifier.startsWith('.') || specifier.startsWith('@/')) {
				const dependency = (
					specifier.startsWith('@/')
						? `src/${specifier.slice(2)}`
						: posix.normalize(posix.join(posix.dirname(file), specifier))
				).replace(/\.js$/, '.ts');
				if (!allowed.has(dependency)) throw new Error(`${file}: undeclared dependency ${specifier}`);
			} else if (!specifier.startsWith('node:')) {
				const packageName = specifier.startsWith('@')
					? specifier.split('/').slice(0, 2).join('/')
					: specifier.split('/')[0];
				if (!manifest.externalDependencies.includes(packageName)) throw new Error(`${file}: undeclared dependency ${specifier}`);
			}
		}
	}
	const entityImports = [];
	// 一つの入口にまとめると、Entity の利用だけでも migration 側のネイティブ依存をロードしてしまう。
	const entityNames = [];
	for (const file of manifest.files) {
		const name = expected
			.get(file)
			.toString()
			.match(/export class (Mi\w+)/)?.[1];
		if (name) {
			entityImports.push(`import { ${name} } from '../${file.replace(/\.ts$/, '.js')}';`);
			entityNames.push(name);
		}
	}
	expected.set(
		'exports/entities.ts',
		Buffer.from(
			`${header}${entityImports.join('\n')}\nexport { ${entityNames.join(', ')} };\nexport const entities = [${entityNames.join(', ')}];\n`,
		),
	);
	const migrationImports = [];
	const migrationNames = [];
	for (const [index, file] of migrationFiles.entries()) {
		const names = [
			...expected
				.get(file)
				.toString()
				.matchAll(/export class (\w+)/g),
		].map((m) => m[1]);
		if (names.length !== 1) throw new Error(`Expected one migration class: ${file}`);
		const alias = `Migration${index}`;
		migrationImports.push(`import { ${names[0]} as ${alias} } from '../${file}';`);
		migrationNames.push(alias);
	}
	expected.set(
		'exports/migrations.ts',
		Buffer.from(`${header}${migrationImports.join('\n')}\nexport const migrations = [${migrationNames.join(', ')}];\n`),
	);
	let previous = [];
	try {
		previous = JSON.parse(await readFile(resolve(destination, '.managed-files.json'), 'utf8'));
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
	for (const path of previous) safePath(path);
	const obsolete = previous.filter((file) => !expected.has(file));
	const mismatches = [];
	for (const [file, content] of expected) {
		let actual;
		try {
			actual = await readFile(resolve(destination, file));
		} catch (e) {
			if (e.code !== 'ENOENT') throw e;
		}
		if (!actual?.equals(content)) mismatches.push(file);
	}
	const inventory = JSON.stringify([...expected.keys()].sort(), null, '\t') + '\n';
	let priorInventory;
	try {
		priorInventory = await readFile(resolve(destination, '.managed-files.json'), 'utf8');
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
	if (check) {
		if (mismatches.length || obsolete.length || inventory !== priorInventory) throw new Error(`out of sync: ${[...mismatches, ...obsolete].join(', ')}`);
		return;
	}
	// ディレクトリごと消すと手書きファイルまで失うため、前回の管理対象だけを削除する。
	for (const file of obsolete) await rm(resolve(destination, file), { force: true });
	for (const [file, content] of expected) {
		const output = resolve(destination, file);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, content);
	}
	await writeFile(resolve(destination, '.managed-files.json'), inventory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const destination = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	await sync({ repository: resolve(destination, '../..'), destination, check: process.argv.includes('--check') });
}
