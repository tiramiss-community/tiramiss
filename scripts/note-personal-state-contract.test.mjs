/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../docs/superpowers/compatibility/note-personal-state/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('personal state expectations remain reproducible from pinned upstream Git blobs', () => {
	execFileSync(process.execPath, [new URL('source-probe.mjs', directory).pathname, '--check'], { stdio: 'pipe' });
	const observations = JSON.parse(readFileSync(new URL('observations.json', directory)));
	assert.equal(observations.corpusSha256, hash(readFileSync(new URL('corpus.json', directory))));
	assert.equal(observations.cases.length, 26);
	assert.equal(observations.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
});
