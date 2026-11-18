/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import pg from 'pg';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';

export function createRuntimeDataSource(options: Extract<DataSourceOptions, { type: 'postgres' }>): DataSource {
	const pools = new Set<pg.Pool>();
	class RuntimePool extends pg.Pool {
		constructor(...args: ConstructorParameters<typeof pg.Pool>) {
			super(...args);
			pools.add(this);
		}
	}

	return new class extends DataSource {
		override async initialize(): Promise<this> {
			try {
				await super.initialize();
				pools.clear();
				return this;
			} catch (error) {
				// TypeORM connect() can reject before assigning its master or the completed slave pools.
				// Track construction via its supported pg driver option so every partial pool is still owned.
				await Promise.allSettled([...pools].filter(pool => !pool.ending).map(pool => pool.end()));
				pools.clear();
				throw error;
			}
		}
	}({ ...options, driver: { ...pg, Pool: RuntimePool } });
}
