/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { projectPromoReadInput } from './promo-read-predecessor.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/promo-read/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('promo/read source observations bind the finite corpus, auth metadata and exact source files', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const observations = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observations.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observations.corpusSha256, sha(read(directory + 'corpus.json')));
	assert.deepEqual(observations.cases.map(item => item.id), corpus.cases.map(item => item.id));
	assert.equal(new Set(observations.cases.map(item => item.id)).size, 14);
	assert.deepEqual(observations.access, { requireCredential: true, kind: 'write:account' });
	assert.deepEqual(observations.manifest, [
		{ path: 'packages/backend/src/server/api/endpoints/promo/read.ts', sha256: '324474b7d1305c0ce4212c7a1e75d518f1d791e33f42175b0f878243f856bd01' },
		{ path: 'packages/backend/src/server/api/GetterService.ts', sha256: '8c8864d50e7524b3ff358e2bb4ff5aceda8e3f1e3a7ad8efe1e7ac9c1b4236c7' },
		{ path: 'packages/backend/src/models/PromoRead.ts', sha256: 'f1a1d6c982b5347c10c9887607eeda0c545ebd3b64709344cffc4dd3dcf88bbd' },
	]);
});

test('only the three exact synchronized additions project to historical bytes; unknown drift passes through', () => {
	const { files } = JSON.parse(read(directory + 'compatibility-predecessor.json'));
	assert.equal(Object.keys(files).length, 3);
	for (const [path, binding] of Object.entries(files)) {
		const current = read(path);
		assert.equal(sha(current), binding.currentSha256);
		const previous = projectPromoReadInput(path, current);
		assert.equal(sha(previous), binding.previousSha256);
		assert.equal(projectPromoReadInput(path, previous), previous);
		const drift = Buffer.concat([current, Buffer.from('\n')]);
		assert.equal(projectPromoReadInput(path, drift), drift);
	}
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectPromoReadInput('unrelated', unrelated), unrelated);
});

test('PG replay rejects non-disposable and remote targets before connecting', () => {
	for (const database of [{ database: 'production', host: '127.0.0.1' }, { database: `backend_next_${'a'.repeat(32)}`, host: 'remote.test' }]) {
		assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../' + directory + 'source-probe.mjs', import.meta.url)), '--pg'], {
			input: JSON.stringify({ database, cases: [] }), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
		}), /promo probe requires a (?:disposable|local) test database/);
	}
});
