/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { testConfig } from '../helpers/database.js';

async function observe(scenario: string, concurrent: boolean): Promise<Record<string, unknown>> {
	const { stdout } = await promisify(execFile)(process.execPath, [
		new URL('../helpers/migration-proof-child.mjs', import.meta.url).pathname,
		scenario,
		JSON.stringify(testConfig().database),
	], {
		env: { ...process.env, MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY: concurrent ? '1' : '0' },
		timeout: 110000,
		maxBuffer: 4 * 1024 * 1024,
	});
	const line = stdout.split('\n').find(item => item.startsWith('MIGRATION_PROOF_RESULT '));
	expect(line).toBeDefined();
	const result = JSON.parse(line!.slice('MIGRATION_PROOF_RESULT '.length));
	if (process.env.MIGRATION_PROOF_OBSERVATIONS) {
		await appendFile(process.env.MIGRATION_PROOF_OBSERVATIONS, `${JSON.stringify({ scenario, mode: concurrent ? 'each' : 'all', result })}\n`);
	}
	return result;
}

test.each([false, true])('uses the actual upstream transaction flags in a fresh process (concurrent=%s)', async concurrent => {
	expect(await observe('transaction', concurrent)).toEqual({
		mode: concurrent ? 'each' : 'all',
		transaction: concurrent ? [false, false] : [null, null],
		incompatibleAllRejected: concurrent,
	});
});

test('preserves 348 existing rows through the real concurrent migrate/check CLI and distinguishes diagnostics', async () => {
	expect(await observe('history', true)).toMatchObject({ before: 348, after: 349, preserved: true, repeated: true, checks: [0, 0], missing: { code: 'MIGRATION_HISTORY_MISSING' }, pending: { code: 'PENDING_MIGRATIONS' }, drift: 'SCHEMA_DRIFT', internalCount: 9 });
});

test.each([false, true])('reports the actual remaining state after the second index fails and recovers after repair (concurrent=%s)', async concurrent => {
	expect(await observe('failure', concurrent)).toMatchObject({ before: 342, after: 349, firstIndexRemained: concurrent, secondIndexRemained: false, internalAbsentOnFailure: true, pending: 7, recoveredValid: true, validIndexesReused: true });
});

test('replaces a PostgreSQL-invalid composite index and reuses its valid replacement', async () => {
	expect(await observe('composite', true)).toMatchObject({ invalidBefore: true, validAfter: true, invalidReplaced: true, validReused: true, oldIndexDropped: true });
});

test('replaces both invalid favorite/pin indexes with the real nonunique noteId definitions', async () => {
	expect(await observe('invalid-pin', true)).toMatchObject({ invalidBefore: 2, validNonUniqueAfter: 2, invalidReplaced: true });
});
