/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPromoInput } from './promo-predecessor.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/promo/';

test('promo source observations bind the finite corpus and source manifest without claiming full upstream HTTP', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const observed = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observed.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observed.corpusSha256, sha(read(directory + 'corpus.json')));
	assert.deepEqual(observed.cases.map(item => item.id), corpus.cases.map(item => item.id));
	assert.equal(new Set(observed.cases.map(item => item.id)).size, 18);
	assert.deepEqual(observed.access, { requireCredential: true, requireModerator: true, kind: 'write:admin:promo' });
	assert.deepEqual(observed.manifest, [
	  {
	    "path": "packages/backend/src/server/api/endpoints/admin/promo/create.ts",
	    "sha256": "f36d15f10952fde2e69c807d3bcfc8acd0eb67fca6f645afc587677a17cddc1b"
	  },
	  {
	    "path": "packages/backend/src/server/api/GetterService.ts",
	    "sha256": "8c8864d50e7524b3ff358e2bb4ff5aceda8e3f1e3a7ad8efe1e7ac9c1b4236c7"
	  },
	  {
	    "path": "packages/backend/src/models/PromoNote.ts",
	    "sha256": "a71dbb5bb9846a681c0995715d21f35309c64d3ef7388cf40d84506d5fc3138e"
	  }
	]);
	assert.match(observed.doubles, /Neither mode runs full upstream HTTP/);
});

test('promo additive inputs preserve exact historical bytes and pass unknown drift to existing guards', () => {
	const { files } = JSON.parse(read(directory + 'compatibility-predecessor.json'));
	assert.equal(Object.keys(files).length, 6);
	for (const [path, binding] of Object.entries(files)) {
		const current = read(path);
		assert.equal(sha(current), binding.currentSha256);
		assert.equal(sha(projectPromoInput(path, current)), binding.previousSha256);
		const drift = Buffer.concat([current, Buffer.from('\n')]);
		assert.equal(projectPromoInput(path, drift), drift);
		const previous = projectPromoInput(path, current);
		assert.equal(projectPromoInput(path, previous), previous);
	}
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectPromoInput('unrelated', unrelated), unrelated);
});


test('PG source replay rejects non-disposable and remote databases before connecting or clearing rows', () => {
	for (const database of [
		{ database: 'production', host: '127.0.0.1' },
		{ database: `backend_next_${'a'.repeat(32)}`, host: 'database.remote.test' },
	]) {
		assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../docs/superpowers/compatibility/promo/source-probe.mjs', import.meta.url)), '--pg'], {
			input: JSON.stringify({ database, cases: [] }), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
		}), /promo probe requires a (?:disposable|local) test database/);
	}
});
