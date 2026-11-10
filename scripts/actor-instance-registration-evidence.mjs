/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Additive current-byte projection; historic corpora, commands and counts stay intact.
export function actorInstanceDigest(file, historicalDigest, label = 'actor instance previous source identity') {
	const receipt = JSON.parse(readFileSync(new URL('../docs/superpowers/compatibility/remote-user/actor-instance-registration-runtime-evidence.json', import.meta.url), 'utf8'));
	const renewal = receipt.renewals[file];
	if (!renewal) {
		return historicalDigest;
	}
	assert(renewal.previousSha256.includes(historicalDigest), label);
	const measurement = receipt.measurements[renewal.measurement];
	assert.equal(measurement?.outcome, 'PASS', 'actor instance actual successful measurement');
	assert.equal(measurement.failed, 0);
	assert.equal(measurement.skipped, 0);
	assert.equal(measurement.sourceSha256[file], renewal.sourceSha256, 'actor instance measured source');
	return renewal.sourceSha256;
}
