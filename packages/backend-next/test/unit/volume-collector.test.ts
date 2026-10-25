/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('DB-host collector measures its explicit volume path and atomically writes a bounded observation', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'volume-collector-'));
	try {
		const file = join(directory, 'volume.json');
		await promisify(execFile)(process.execPath, [resolve('built/entrypoints/collect-volume.js'), directory, 'dedicated-test-volume', file]);
		const value = JSON.parse(await readFile(file, 'utf8'));
		const stats = await statfs(directory, { bigint: true });
		expect(value.volumeId).toBe('dedicated-test-volume');
		expect(value.totalBytes).toBe((stats.blocks * stats.bsize).toString());
		expect(BigInt(value.freeBytes)).toBeLessThanOrEqual(BigInt(value.totalBytes));
		expect(Date.now() - value.observedAtMs).toBeLessThan(5000);
	} finally {
		await rm(directory, { recursive: true });
	}
});
