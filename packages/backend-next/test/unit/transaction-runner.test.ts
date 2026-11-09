/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { deferred } from './role/fixtures.js';
import type { TransactionLifetime } from '../../src/platform/database/transaction-runner.js';
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

test('keeps capabilities active through awaited work and expires before commit', async () => {
	const entered = deferred<void>();
	const finishWork = deferred<void>();
	const callbackEnded = deferred<void>();
	const commit = deferred<void>();
	const database = vi.fn();
	let lifetime!: TransactionLifetime;
	const source = {
		transaction: async (work: (manager: EntityManager) => Promise<unknown>) => {
			const result = await work({} as EntityManager);
			callbackEnded.resolve();
			expect(() => lifetime.assertActive()).toThrow('The transaction has ended');
			await commit.promise;
			return result;
		},
	} as unknown as DataSource;
	const runner = createTransactionRunner(source, (_manager, guard) => {
		lifetime = guard;
		return { write: async () => {
			guard.assertActive();
			database();
		} };
	});
	let escaped!: { write(): Promise<void> };
	let returned = false;
	const running = runner.run(async scope => {
		escaped = scope;
		entered.resolve();
		await finishWork.promise;
		await scope.write();
		return 42;
	}).then(value => {
		returned = true;
		return value;
	});
	await entered.promise;
	try {
		expect(() => lifetime.assertActive()).not.toThrow();
		await escaped.write();
		expect(database).toHaveBeenCalledTimes(1);
		finishWork.resolve();
		await callbackEnded.promise;
		expect(returned).toBe(false);
	} finally {
		finishWork.resolve();
		commit.resolve();
		await Promise.allSettled([running]);
	}
	await callbackEnded.promise;
	expect(await running).toBe(42);
	expect(returned).toBe(true);
	expect(database).toHaveBeenCalledTimes(2);
	await expect(escaped.write()).rejects.toThrow('The transaction has ended');
	expect(database).toHaveBeenCalledTimes(2);
});

test('expires a captured lifetime when bind throws', async () => {
	const failure = new Error('bind rejected');
	let lifetime!: TransactionLifetime;
	const work = vi.fn();
	const source = { transaction: async (callback: (manager: EntityManager) => Promise<unknown>) => callback({} as EntityManager) } as unknown as DataSource;
	const runner = createTransactionRunner(source, (_manager, guard) => {
		lifetime = guard;
		throw failure;
	});
	await expect(runner.run(work)).rejects.toBe(failure);
	expect(work).not.toHaveBeenCalled();
	expect(() => lifetime.assertActive()).toThrow('The transaction has ended');
});

test('expires capabilities when work rejects', async () => {
	const failure = new Error('work rejected');
	const database = vi.fn();
	let escaped!: { write(): Promise<void> };
	const source = { transaction: async (callback: (manager: EntityManager) => Promise<unknown>) => callback({} as EntityManager) } as unknown as DataSource;
	const runner = createTransactionRunner(source, (_manager, lifetime) => ({
		write: async () => {
			lifetime.assertActive();
			database();
		},
	}));
	await expect(runner.run(async scope => {
		escaped = scope;
		throw failure;
	})).rejects.toBe(failure);
	await expect(escaped.write()).rejects.toThrow('The transaction has ended');
	expect(database).not.toHaveBeenCalled();
});

test.each(['commit', 'rollback'] as const)('preserves source rejection after %s failure without retry', async outcome => {
	const sourceFailure = new Error(outcome + ' failed');
	const callbackFailure = new Error('callback failed');
	let lifetime!: TransactionLifetime;
	const transaction = vi.fn(async (callback: (manager: EntityManager) => Promise<unknown>) => {
		try {
			await callback({} as EntityManager);
		} catch (error) {
			expect(error).toBe(callbackFailure);
		}
		expect(() => lifetime.assertActive()).toThrow('The transaction has ended');
		throw sourceFailure;
	});
	const source = { transaction } as unknown as DataSource;
	const runner = createTransactionRunner(source, (_manager, guard) => {
		lifetime = guard;
		return {};
	});
	const work = vi.fn(async () => {
		if (outcome === 'rollback') {
			throw callbackFailure;
		}
	});
	await expect(runner.run(work)).rejects.toBe(sourceFailure);
	expect(transaction).toHaveBeenCalledTimes(1);
	expect(work).toHaveBeenCalledTimes(1);
	expect(() => lifetime.assertActive()).toThrow('The transaction has ended');
});

test('isolates overlapping lifetimes', async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	const database = vi.fn();
	const source = { transaction: async (callback: (manager: EntityManager) => Promise<unknown>) => callback({} as EntityManager) } as unknown as DataSource;
	const runner = createTransactionRunner(source, (_manager, lifetime) => ({
		write: async () => {
			lifetime.assertActive();
			database();
		},
	}));
	let a!: { write(): Promise<void> };
	let b!: { write(): Promise<void> };
	const pending = runner.run(async scope => {
		a = scope;
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	try {
		await runner.run(async scope => {
			b = scope;
			await scope.write();
		});
		await expect(b.write()).rejects.toThrow('The transaction has ended');
		expect(database).toHaveBeenCalledTimes(1);
		await a.write();
		expect(database).toHaveBeenCalledTimes(2);
	} finally {
		release.resolve();
		await pending;
	}
	await expect(a.write()).rejects.toThrow('The transaction has ended');
	expect(database).toHaveBeenCalledTimes(2);
});

test('propagates transaction-open failure without binding', async () => {
	const failure = new Error('cannot open transaction');
	const bind = vi.fn();
	const work = vi.fn();
	const source = { transaction: vi.fn(async () => {
		throw failure;
	}) } as unknown as DataSource;
	await expect(createTransactionRunner(source, bind).run(work)).rejects.toBe(failure);
	expect(bind).not.toHaveBeenCalled();
	expect(work).not.toHaveBeenCalled();
});
