/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import pg from 'pg';
import { CannotConnectAlreadyConnectedError, DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import type { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver.js';

export function createRuntimeDataSource(options: Extract<DataSourceOptions, { type: 'postgres' }>): DataSource {
	const pools = new Set<pg.Pool>();
	class RuntimePool extends pg.Pool {
		constructor(...args: ConstructorParameters<typeof pg.Pool>) {
			super(...args);
			pools.add(this);
		}
	}

	return new class extends DataSource {
		private initializing = false;

		override async initialize(): Promise<this> {
			if (this.isInitialized || this.initializing) {
				throw new CannotConnectAlreadyConnectedError();
			}
			this.initializing = true;
			try {
				await super.initialize();
				pools.clear();
				return this;
			} catch (error) {
				// Failed connect() metadata queries can leave a borrowed runner; pg end() waits for its return.
				const driver = this.driver as PostgresDriver;
				await Promise.allSettled([...driver.connectedQueryRunners].map(runner => runner.release()));
				// TypeORM connect() can reject before assigning its master or the completed slave pools.
				// Track construction via its supported pg driver option so every partial pool is still owned.
				await Promise.allSettled([...pools].filter(pool => !pool.ending).map(pool => pool.end()));
				pools.clear();
				throw error;
			} finally {
				this.initializing = false;
			}
		}
	}({ ...options, driver: { ...pg, Pool: RuntimePool } });
}
