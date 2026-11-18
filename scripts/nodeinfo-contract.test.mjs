/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectParallelInput } from './parallel-inputs.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/nodeinfo/';
const record = JSON.parse(read(directory + 'compatibility-predecessor.json'));

test('NodeInfo preserves only its exact two shared predecessors without renewing historical measurements', () => {
	assert.equal(record.baseline, 'db1f3652fb832889bf2e34575420a6ff61477041');
	assert.deepEqual(Object.keys(record.files), [
		'packages/backend-next/src/composition/http-app.ts',
		'packages/backend-next/test/unit/composition/http-app.test.ts',
	]);
	for (const [path, binding] of Object.entries(record.files)) {
		const actual = read(path);
		assert.equal(sha(actual), binding.currentSha256);
		assert.equal(sha(projectParallelInput(path, actual, binding.previousSha256)), binding.previousSha256);
		assert.equal(sha(projectParallelInput(path, read(path), binding.previousSha256)), binding.previousSha256);
		const drift = Buffer.concat([actual, Buffer.from('\n')]);
		assert.equal(projectParallelInput(path, drift, binding.previousSha256), drift);
	}
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectParallelInput('unrelated', unrelated), unrelated);
});

test('NodeInfo source corpus covers document order, TTL, defaults, each failure and real discovery routes', () => {
	const corpus = JSON.parse(read(directory + 'observations.json'));
	assert.equal(corpus.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.deepEqual(corpus.sources.map(([path]) => path), [
		'packages/backend/src/server/NodeinfoServerService.ts',
		'packages/backend/src/misc/cache.ts',
		'packages/backend/src/server/WellKnownServerService.ts',
		'packages/backend/src/misc/prelude/xml.ts',
		'packages/backend/src/const.ts',
		'packages/backend/src/core/RoleService.ts',
	]);
	assert.equal(corpus.observations.length, 27);
	assert.equal(corpus.discovery.length, 9);
	assert.deepEqual([...new Set(corpus.observations.map(o => o.scenario))], [
		'21-first', '20-first-expiry', 'head-first', 'null-settings', 'failed-refresh', 'federation-none',
		'fault-notes', 'fault-users', 'fault-meta', 'fault-proxy',
	]);
	for (const federation of ['all', 'none', 'fault']) {
		assert.deepEqual(corpus.discovery.filter(o => o.federation === federation).map(o => [o.method, o.status, o.metaReads]), [
			['GET', federation === 'all' ? 200 : federation === 'none' ? 403 : 500, 1],
			['HEAD', federation === 'all' ? 200 : federation === 'none' ? 403 : 500, 1],
			['OPTIONS', 204, 0],
		]);
	}
});
