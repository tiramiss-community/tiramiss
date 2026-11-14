/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL(path, root));

export function loadFollowCollectionsR2History(readFixture = () => read(directory + 'local-follow-collections-r2-history-fixture.json'), readCurrent = read) {
	const bytes = readFixture();
	assert(bytes?.length, 'missing history fixture');
	assert.equal(sha(bytes), 'c5861e12865ee253e925f70abecbc3e67dd1f526bf6362fde730ae7b04059195', 'history fixture bytes');
	const fixture = JSON.parse(bytes);
	assert.equal(fixture.schemaVersion, 1);
	assert.equal(fixture.validatorCommit, '949e3040d4401aea68b7a505dda0b65453237c02');
	assert.equal(fixture.inputCommit, '8f200fc583f40eda2455f2196013b976c39b937d');
	const payload = JSON.parse(gunzipSync(Buffer.from(fixture.gzipBase64, 'base64')));
	const validator = Buffer.from(payload.validator, 'base64');
	assert.equal(sha(validator), '394053a84c26b723e17ddd130bdd5bf1417b11c43660fc0575115ccb792b022d', 'historical validator bytes');
	assert.equal(fixture.validatorSha256, sha(validator), 'historical validator provenance');
	const r2Bytes = readCurrent(directory + 'local-follow-collections-current-evidence.json');
	assert.equal(sha(r2Bytes), 'c3559a2cdbf0c695c091750182136abb18802069702c05939022b6a1d9afcede', 'historical R2 record bytes');
	const expected = JSON.parse(r2Bytes).frozenInputSha256;
	assert.equal(sha(JSON.stringify(Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))), '1d4dc8c435ba99221332fac74be79247520efbf3d9d60acfc90ecb8a15814c88', 'historical input map');
	assert.equal(fixture.inputMapSha256, '1d4dc8c435ba99221332fac74be79247520efbf3d9d60acfc90ecb8a15814c88', 'historical map provenance');
	assert.deepEqual(Object.keys(payload.inputs).sort(), Object.keys(expected).sort(), 'historical input subset');
	const inputs = new Map(Object.entries(payload.inputs).map(([path, data]) => [path, Buffer.from(data, 'base64')]));
	for (const [path, digest] of Object.entries(expected)) assert.equal(sha(inputs.get(path)), digest, 'historical frozen bytes');
	return { validator: validator.toString(), read: path => inputs.has(path) ? Buffer.from(inputs.get(path)) : readCurrent(path) };
}
