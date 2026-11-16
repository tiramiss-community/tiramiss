/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const proof = JSON.parse(readFileSync(new URL('docs/superpowers/compatibility/migration-proof/source.json', root)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = new URL('packages/backend-upstream/migration/', root);
const names = readdirSync(directory).filter(name => name.endsWith('.js')).sort();

test('all 349 migration file names and bytes retain the pinned-source identity', () => {
	assert.equal(names.length, proof.migrationCount);
	const manifest = names.map(name => `${name}\0${digest(readFileSync(new URL(name, directory)))}`).join('\n') + '\n';
	assert.equal(digest(manifest), proof.migrationManifestSha256);
});

test('fixed upstream source uses the same each/all environment contract exercised by the real PG cases', () => {
	assert.match(proof.ormconfigSource, /const isConcurrentIndexMigrationEnabled = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';/);
	assert.match(proof.ormconfigSource, /migrationsTransactionMode: isConcurrentIndexMigrationEnabled \? 'each' : 'all'/);
});

test('optional source checkout verifies every copied migration and the recorded config literal', { skip: !process.env.BACKEND_NEXT_UPSTREAM_PATH }, () => {
	const checkout = process.env.BACKEND_NEXT_UPSTREAM_PATH;
	const source = path => execFileSync('git', ['-C', checkout, 'show', `${proof.upstreamCommit}:${path}`]);
	const upstreamNames = execFileSync('git', ['-C', checkout, 'ls-tree', '--name-only', `${proof.upstreamCommit}:packages/backend/migration`], { encoding: 'utf8' }).trim().split('\n').sort();
	assert.deepEqual(upstreamNames, names);
	for (const name of names) {
		assert.deepEqual(readFileSync(new URL(name, directory)), source(`packages/backend/migration/${name}`), name);
	}
	assert.equal(source('packages/backend/ormconfig.js').toString(), proof.ormconfigSource);
});
