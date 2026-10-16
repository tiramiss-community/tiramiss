/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createTransactionRunner } from '../../src/platform/database/transaction-runner.js';
import type { DataSource, EntityManager } from 'typeorm';
test('returns only after commit and propagates the original callback exception', async () => {
	let committed = false;
	const manager = {} as EntityManager;
	const source = {
		transaction: async (work: (m: EntityManager) => Promise<unknown>) => {
			const result = await work(manager);
			committed = true;
			return result;
		},
	} as unknown as DataSource;
	const runner = createTransactionRunner(source, (m) => ({ manager: m }));
	expect(
		await runner.run(async (scope) => {
			expect(scope.manager).toBe(manager);
			expect(committed).toBe(false);
			return 42;
		}),
	).toBe(42);
	expect(committed).toBe(true);
	const failure = new Error('business rejection');
	await expect(
		runner.run(async () => {
			throw failure;
		}),
	).rejects.toBe(failure);
});
test('preserves uncertain commit failure without claiming rollback or retrying', async () => {
	const failure = new Error('connection lost while committing');
	let executions = 0;
	const source = {
		transaction: async (work: (m: EntityManager) => Promise<unknown>) => {
			await work({} as EntityManager);
			throw failure;
		},
	} as unknown as DataSource;
	const runner = createTransactionRunner(source, () => ({}));
	await expect(
		runner.run(async () => {
			executions++;
		}),
	).rejects.toBe(failure);
	expect(executions).toBe(1);
});
