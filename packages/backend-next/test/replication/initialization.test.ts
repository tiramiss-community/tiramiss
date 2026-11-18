/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CannotConnectAlreadyConnectedError } from 'typeorm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createRuntimeDataSource } from '../../src/platform/database/runtime-data-source.js';
import { testConfig } from '../helpers/database.js';
import type { QueryRunner } from 'typeorm';
import type { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver.js';

const primary = testConfig().database;
const replica = { ...primary, port: Number(process.env.BACKEND_NEXT_TEST_REPLICA_DB_PORT ?? 55433) };
const observers = [primary, replica].map(database => new pg.Client({
	host: database.host, port: database.port, database: database.database, user: database.username, password: database.password,
}));

beforeAll(async () => {
	await Promise.all(observers.map(client => client.connect()));
});
afterAll(async () => {
	await Promise.allSettled(observers.map(client => client.end()));
});

for (const replicated of [false, true]) {
	for (const metadata of ['getVersion', 'getCurrentSchema'] as const) {
		test(`metadata ${metadata} failure releases borrowed runners and pools (replication: ${replicated})`, async () => {
			const applicationName = `initialization-${randomUUID()}`;
			const source = createRuntimeDataSource({
				type: 'postgres', ...primary, entities: [], installExtensions: false,
				...(replicated ? { replication: { master: primary, slaves: [replica] } } : {}),
				extra: { application_name: applicationName, idleTimeoutMillis: 0 },
			});
			const driver = source.driver as PostgresDriver;
			const createRunner = driver.createQueryRunner.bind(driver);
			driver.createQueryRunner = mode => {
				const runner = createRunner(mode);
				// A real server error after the metadata runner borrows its connection.
				runner[metadata] = async () => {
					await runner.query('SELECT 1 / 0');
					throw new Error('Expected PostgreSQL division-by-zero failure');
				};
				return runner;
			};
			const initialization = source.initialize().then(
				() => ({ status: 'fulfilled' as const }),
				error => ({ status: 'rejected' as const, error: error as unknown }),
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const outcome = await Promise.race([
					initialization,
					new Promise<{ status: 'timeout' }>(resolve => {
						timer = setTimeout(() => resolve({ status: 'timeout' }), 1000);
					}),
				]);
				expect(outcome.status).toBe('rejected');
				if (outcome.status === 'rejected') {
					expect(outcome.error).toMatchObject({ driverError: { code: '22012' } });
				}
				expect(source.isInitialized).toBe(false);
				for (const observer of observers) {
					await expect.poll(async () => (await observer.query('SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE application_name = $1', [applicationName])).rows,
						{ timeout: 1000, interval: 25 }).toEqual([{ sessions: 0 }]);
				}
				driver.createQueryRunner = createRunner;
				await source.initialize();
				expect(await source.query('SELECT 1 AS ready')).toEqual([{ ready: 1 }]);
			} finally {
				clearTimeout(timer);
				// The red reproduction must release the leaked runner so its worker can exit.
				await Promise.allSettled([...driver.connectedQueryRunners].map(runner => runner.release()));
				await initialization;
				if (source.isInitialized) {
					await source.destroy();
				}
			}
		});
	}
}

for (const replicated of [false, true]) {
	const options = {
		type: 'postgres' as const, ...primary, entities: [], installExtensions: false,
		...(replicated ? { replication: { master: primary, slaves: [replica] } } : {}),
	};

	test(`redundant initialization preserves an active held connection and permits reinitialization after destroy (replication: ${replicated})`, async () => {
		const source = await createRuntimeDataSource(options).initialize();
		const runner = source.createQueryRunner();
		try {
			await runner.query('SELECT 1');
			await expect(source.initialize()).rejects.toBeInstanceOf(CannotConnectAlreadyConnectedError);
			expect(runner.isReleased).toBe(false);
			expect(await runner.query('SELECT 2 AS alive')).toEqual([{ alive: 2 }]);
			await runner.release();
			await source.destroy();
			await source.initialize();
			expect(await source.query('SELECT 3 AS ready')).toEqual([{ ready: 3 }]);
		} finally {
			await runner.release();
			if (source.isInitialized) {
				await source.destroy();
			}
		}
	});

	test(`concurrent initialization cannot release another attempt's held metadata connection (replication: ${replicated})`, async () => {
		const source = createRuntimeDataSource(options);
		const driver = source.driver as PostgresDriver;
		const connect = driver.connect.bind(driver);
		let connecting = false;
		driver.connect = async () => {
			if (connecting) {
				throw new Error('Unexpected overlapping driver connection');
			}
			connecting = true;
			await connect();
		};
		let resume!: () => void;
		const paused = new Promise<void>(resolve => {
			resume = resolve;
		});
		let borrowed!: () => void;
		const ready = new Promise<void>(resolve => {
			borrowed = resolve;
		});
		let held!: QueryRunner;
		const createRunner = driver.createQueryRunner.bind(driver);
		driver.createQueryRunner = mode => {
			const runner = createRunner(mode);
			const getVersion = runner.getVersion.bind(runner);
			runner.getVersion = async () => {
				await runner.query('SELECT 1');
				held = runner;
				borrowed();
				await paused;
				return getVersion();
			};
			return runner;
		};
		const initialization = source.initialize().then(
			() => ({ status: 'fulfilled' as const }),
			error => ({ status: 'rejected' as const, error: error as unknown }),
		);
		try {
			await ready;
			await expect(source.initialize()).rejects.toBeInstanceOf(CannotConnectAlreadyConnectedError);
			expect(await held.query('SELECT 2 AS alive')).toEqual([{ alive: 2 }]);
			resume();
			expect(await initialization).toEqual({ status: 'fulfilled' });
			expect(await source.query('SELECT 3 AS ready')).toEqual([{ ready: 3 }]);
		} finally {
			resume();
			await initialization;
			if (source.isInitialized) {
				await source.destroy();
			}
		}
	});
}
