/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Finite additive identity chain; the original observations and run receipts remain historical.
export function metadataDigest(file, historicalDigest, label = 'instance metadata previous measured identity') {
	const receipt = JSON.parse(readFileSync(new URL('../docs/superpowers/compatibility/instance-metadata/runtime-evidence.json', import.meta.url), 'utf8'));
	const renewal = receipt.renewals[file];
	if (!renewal) {
		return historicalDigest;
	}
	assert(renewal.previousSha256.includes(historicalDigest) || renewal.sourceSha256 === historicalDigest, label);
	const measurement = receipt.measurements[renewal.measurement];
	assert.equal(measurement?.outcome, 'PASS', 'metadata actual successful measurement');
	assert.equal(measurement.failed, 0);
	assert.equal(measurement.skipped, 0);
	assert(measurement.passed > 0);
	assert.equal(measurement.sourceSha256[file], renewal.sourceSha256, 'metadata measured current source');
	return renewal.sourceSha256;
}
