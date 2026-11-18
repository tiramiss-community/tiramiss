/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const exec = promisify(execFile);

test('reads and writes all 24 existing chart tables while preserving schema and migration history', async () => {
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const { stdout } = await exec(process.execPath, ['docs/superpowers/compatibility/chart-storage/database-probe.mjs', '--check'], {
		cwd: root,
		env: { ...process.env, BACKEND_NEXT_TEST_DB_PORT: process.env.BACKEND_NEXT_TEST_DB_PORT ?? '55432' },
		maxBuffer: 1024 * 1024,
	});
	expect(stdout).toContain('24 tables / 36 historical rows; read/update/insert/uniqueness/drift/history PASS --check');
});
