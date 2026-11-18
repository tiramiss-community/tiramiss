/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import 'reflect-metadata';
import pg from 'pg';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { entities } from 'backend-upstream/entities';
import { noteChartEntities } from './chart/schema.js';
import { notificationEntities } from './notification/schema.js';
import type { DatabaseConfig } from '../../config/types.js';

// Match upstream's scalar conversion, including Number precision and unchanged int8 arrays.
pg.types.setTypeParser(20, Number);

export function databaseOptions(
	config: DatabaseConfig,
	timeoutMs = 30000,
): Extract<DataSourceOptions, { type: 'postgres' }> {
	const { replicas: _replicas, ...primary } = config;
	return {
		type: 'postgres',
		...primary,
		extra: { ...config.extra, connectionTimeoutMillis: timeoutMs },
		entities: [...entities, ...notificationEntities, ...noteChartEntities],
		synchronize: false,
		migrationsRun: false,
		logging: false,
		installExtensions: false,
	};
}

export function createDataSource(config: DatabaseConfig, timeoutMs = 30000): DataSource {
	const options = databaseOptions(config, timeoutMs);
	// Upstream's CLI ormconfig stays on the primary and inherits its timeout; replication and defaults are runtime-only.
	return new DataSource({
		...options,
		...(config.replicas === undefined ? {} : { replication: {
			master: { host: config.host, port: config.port, database: config.database, username: config.username, password: config.password },
			slaves: config.replicas,
		} }),
		extra: { statement_timeout: 10000, ...options.extra },
		invalidWhereValuesBehavior: { null: 'ignore', undefined: 'ignore' },
	});
}
