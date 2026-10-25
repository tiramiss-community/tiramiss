/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(repository, 'docs/superpowers/compatibility/note');
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;

function withTemporaryDirectory(run) {
	const directory = mkdtempSync(join(tmpdir(), 'note-contract-review-'));
	try {
		return run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test('fixed note observations still validate after upstream sync advances', () => withTemporaryDirectory(directory => {
	mkdirSync(join(directory, 'scripts'), { recursive: true });
	cpSync(join(repository, 'scripts/note-contract-fixtures.test.mjs'), join(directory, 'scripts/note-contract-fixtures.test.mjs'));
	cpSync(artifacts, join(directory, 'docs/superpowers/compatibility/note'), { recursive: true });
	const upstream = join(directory, 'packages/backend-upstream');
	mkdirSync(upstream, { recursive: true });
	writeFileSync(join(upstream, 'upstream-sync.json'), JSON.stringify({ commit: 'f'.repeat(40) }));
	const output = execFileSync(process.execPath, ['--test', 'scripts/note-contract-fixtures.test.mjs'], { cwd: directory, encoding: 'utf8', env: childEnvironment });
	assert.match(output, /pass 4/);
}));

// A small DB double models primary-key collisions and role-delete cascades.
// The child executes the actual probe, including its finally block.
const databaseDouble = `
import { readFileSync, writeFileSync } from 'node:fs';
export default { Client: class {
  constructor() { this.state = JSON.parse(readFileSync(process.env.NOTE_REVIEW_STATE, 'utf8')); }
  async connect() {}
  async query(sql, args) {
    const state = this.state;
    if (sql.startsWith('SELECT id, token')) return { rows: [{ id: 'actor', token: 'test-only' }] };
    if (sql.startsWith('INSERT INTO role_assignment')) {
      if (state.assignments[args[0]]) throw new Error('assignment primary key collision');
      state.assignments[args[0]] = { roleId: args[1], userId: args[2] };
    } else if (sql.startsWith('INSERT INTO role ')) {
      if (state.roles[args[0]]) throw new Error('role primary key collision');
      state.roles[args[0]] = { name: args[1] };
    } else if (sql.startsWith('DELETE FROM role_assignment')) {
      delete state.assignments[args[0]];
    } else if (sql.startsWith('DELETE FROM role ')) {
      delete state.roles[args[0]];
      for (const [id, row] of Object.entries(state.assignments)) {
        if (row.roleId === args[0]) delete state.assignments[id];
      }
    } else throw new Error('unexpected DB operation: ' + sql);
    return { rows: [] };
  }
  async end() { writeFileSync(process.env.NOTE_REVIEW_STATE, JSON.stringify({ ...this.state, closed: true })); }
} };
`;

function failedProbe(initial, expectedError) {
	return withTemporaryDirectory(directory => {
		const backend = join(directory, 'backend');
		const testDirectory = join(backend, 'test');
		const built = join(backend, 'built');
		const driver = join(backend, 'node_modules/pg');
		for (const path of [testDirectory, built, driver]) {
			mkdirSync(path, { recursive: true });
		}
		writeFileSync(join(backend, 'package.json'), JSON.stringify({ type: 'module' }));
		writeFileSync(join(driver, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
		writeFileSync(join(driver, 'index.js'), databaseDouble);
		writeFileSync(join(built, 'config.js'), `export const loadConfig = () => (${JSON.stringify({ db: { host: '127.0.0.1', port: 55167, db: 'backend_next_test', user: 'unused', pass: 'unused' }, redis: { host: '127.0.0.1', port: 56167 }, port: 61167 })});`);
		writeFileSync(join(built, 'entry.js'), 'process.exit(7);\n');
		cpSync(join(artifacts, 'reference-note-rate.mjs'), join(testDirectory, 'note-rate.mjs'));
		cpSync(join(artifacts, 'rate-observations.json'), join(testDirectory, 'note-rate-observations.json'));
		const stateFile = join(directory, 'state.json');
		writeFileSync(stateFile, JSON.stringify(initial));
		const result = spawnSync(process.execPath, [join(testDirectory, 'note-rate.mjs')], { encoding: 'utf8', timeout: 5000, env: { ...childEnvironment, NOTE_REVIEW_STATE: stateFile, NOTE_PROBE_RECORD: '0' } });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 1);
		assert.match(result.stderr, expectedError);
		const final = JSON.parse(readFileSync(stateFile, 'utf8'));
		assert.equal(final.closed, true);
		return final;
	});
}

test('a role INSERT collision preserves the existing role and its assignments', () => {
	const initial = { roles: { note167rateRole: { name: 'existing' } }, assignments: { dependent: { roleId: 'note167rateRole', userId: 'other' } } };
	assert.deepEqual(failedProbe(initial, /role primary key collision/), { ...initial, closed: true });
});

test('an assignment INSERT collision preserves it and removes only the newly created role', () => {
	const initial = { roles: { otherRole: { name: 'existing' } }, assignments: { note167rateAssignment: { roleId: 'otherRole', userId: 'other' } } };
	assert.deepEqual(failedProbe(initial, /assignment primary key collision/), { ...initial, closed: true });
});

test('a later server startup failure removes both successfully created probe rows', () => {
	const initial = { roles: {}, assignments: {} };
	assert.deepEqual(failedProbe(initial, /production server exited/), { ...initial, closed: true });
});
