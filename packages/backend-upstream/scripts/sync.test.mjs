/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sync } from './sync.mjs';

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'backend-sync-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
	git('init', '-q');
	await mkdir(join(root, 'packages/backend/src/models'), { recursive: true });
	await mkdir(join(root, 'packages/backend/migration'), { recursive: true });
	await writeFile(join(root, 'packages/backend/src/models/Role.ts'), 'export class MiRole {}\n');
	await writeFile(
		join(root, 'packages/backend/migration/1000000000000-First.js'),
		'export class First1000000000000 {}\n',
	);
	git('add', '.');
	git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
	const manifest = {
		commit: git('rev-parse', 'HEAD'),
		files: ['src/models/Role.ts'],
		migrationDirectory: 'migration',
		externalDependencies: [],
		generatorVersion: 1,
	};
	const dest = join(root, 'library');
	await mkdir(dest);
	await writeFile(join(dest, 'upstream-sync.json'), JSON.stringify(manifest));
	return { root, git, dest, manifest };
}

test('copies the pinned Git content, checks tampering and keeps handwritten files', async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, 'packages/backend/src/models/Role.ts'), 'uncommitted change');
	await sync({ repository: f.root, destination: f.dest });
	assert.equal(await readFile(join(f.dest, 'src/models/Role.ts'), 'utf8'), 'export class MiRole {}\n');
	const generated = await readFile(join(f.dest, 'exports/migrations.ts'), 'utf8');
	assert.match(generated, /First1000000000000/);
	await sync({ repository: f.root, destination: f.dest, check: true });
	await writeFile(join(f.dest, 'src/models/Role.ts'), 'tampered');
	await assert.rejects(sync({ repository: f.root, destination: f.dest, check: true }), /out of sync/);
	await writeFile(join(f.dest, 'README.md'), 'handwritten');
	await sync({ repository: f.root, destination: f.dest });
	assert.equal(await readFile(join(f.dest, 'README.md'), 'utf8'), 'handwritten');
});

test('rejects undeclared local and external dependencies before copying', async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, 'packages/backend/src/models/Role.ts'), "import './Missing.js';\n");
	f.git('add', '.');
	f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'dependency');
	f.manifest.commit = f.git('rev-parse', 'HEAD');
	await writeFile(join(f.dest, 'upstream-sync.json'), JSON.stringify(f.manifest));
	await assert.rejects(sync({ repository: f.root, destination: f.dest }), /undeclared dependency/);
	await writeFile(join(f.root, 'packages/backend/src/models/Role.ts'), "import x from 'unknown-package';\n");
	f.git('add', '.');
	f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'external');
	f.manifest.commit = f.git('rev-parse', 'HEAD');
	await writeFile(join(f.dest, 'upstream-sync.json'), JSON.stringify(f.manifest));
	await assert.rejects(sync({ repository: f.root, destination: f.dest }), /undeclared dependency/);
});

test('removes obsolete managed files but preserves handwritten files across source updates', async (t) => {
	const f = await fixture(t);
	await sync({ repository: f.root, destination: f.dest });
	await writeFile(join(f.dest, 'README.md'), 'keep');
	f.git('rm', 'packages/backend/migration/1000000000000-First.js');
	await mkdir(join(f.root, 'packages/backend/migration'), { recursive: true });
	await writeFile(
		join(f.root, 'packages/backend/migration/1000000000001-Second.js'),
		'export class Second1000000000001 {}\n',
	);
	f.git('add', '.');
	f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'replace');
	f.manifest.commit = f.git('rev-parse', 'HEAD');
	await writeFile(join(f.dest, 'upstream-sync.json'), JSON.stringify(f.manifest));
	await sync({ repository: f.root, destination: f.dest });
	await assert.rejects(readFile(join(f.dest, 'migration/1000000000000-First.js')), { code: 'ENOENT' });
	assert.equal(await readFile(join(f.dest, 'README.md'), 'utf8'), 'keep');
	await sync({ repository: f.root, destination: f.dest, check: true });
});

test('copies an explicitly declared shared type definition without changing alias imports', async (t) => {
	const f = await fixture(t);
	const entity = "import { values } from '@/types.js';\nexport class MiRole {}\n";
	const types = "export const values = ['public'] as const;\n";
	await writeFile(join(f.root, 'packages/backend/src/models/Role.ts'), entity);
	await writeFile(join(f.root, 'packages/backend/src/types.ts'), types);
	f.git('add', 'packages/backend/src');
	f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'shared types');
	f.manifest.commit = f.git('rev-parse', 'HEAD');
	await writeFile(join(f.dest, 'upstream-sync.json'), JSON.stringify(f.manifest));
	await assert.rejects(sync({ repository: f.root, destination: f.dest }), /undeclared dependency/);
	f.manifest.files.push('src/types.ts');
	await writeFile(join(f.dest, 'upstream-sync.json'), JSON.stringify(f.manifest));
	await sync({ repository: f.root, destination: f.dest });
	assert.equal(await readFile(join(f.dest, 'src/models/Role.ts'), 'utf8'), entity);
	assert.equal(await readFile(join(f.dest, 'src/types.ts'), 'utf8'), types);
	await sync({ repository: f.root, destination: f.dest, check: true });
});

test('does not allow arbitrary source files when shared types are permitted', async (t) => {
	const f = await fixture(t);
	f.manifest.files.push('src/Service.ts');
	await writeFile(join(f.dest, 'upstream-sync.json'), JSON.stringify(f.manifest));
	await assert.rejects(sync({ repository: f.root, destination: f.dest }), /Invalid managed path/);
});
