/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { createTransactionRunner } from '../../src/platform/database/transaction-runner.js';
import type { DataSource } from 'typeorm';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
beforeAll(async () => {
	database = await createTestDatabase();
	source = await createDataSource(database.config.database).initialize();
	await source.query('CREATE SCHEMA transaction_test');
	await source.query('CREATE TABLE transaction_test.values (value integer)');
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});
test('commits two writes together and rolls both back on exception using the same connection', async () => {
	const runner = createTransactionRunner(source, (manager) => ({
		append: (value: number) => manager.query('INSERT INTO transaction_test.values VALUES ($1)', [value]),
		pid: () => manager.query('SELECT pg_backend_pid() AS pid'),
	}));
	await runner.run(async (tx) => {
		expect(await tx.pid()).toEqual(await tx.pid());
		await tx.append(1);
		await tx.append(2);
	});
	const rejection = new Error('reject');
	await expect(
		runner.run(async (tx) => {
			await tx.append(3);
			await tx.append(4);
			throw rejection;
		}),
	).rejects.toBe(rejection);
	expect(await source.query('SELECT value FROM transaction_test.values ORDER BY value')).toEqual([
		{ value: 1 },
		{ value: 2 },
	]);
});
test('gives concurrent operations distinct transaction scopes and database transactions', async () => {
	const runner = createTransactionRunner(source, (manager) => ({
		identity: () => manager.query('SELECT txid_current()::text AS id'),
	}));
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	let first!: () => void;
	const entered = new Promise<void>((resolve) => {
		first = resolve;
	});
	const a = runner.run(async (tx) => {
		const identity = await tx.identity();
		first();
		await barrier;
		return identity;
	});
	await entered;
	let b;
	try {
		b = await runner.run((tx) => tx.identity());
	} finally {
		release();
	}
	expect(await a).not.toEqual(b);
});
