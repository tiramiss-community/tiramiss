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
	return {
		type: 'postgres',
		...config,
		extra: { statement_timeout: 10000, ...config.extra, connectionTimeoutMillis: timeoutMs },
		invalidWhereValuesBehavior: { null: 'ignore', undefined: 'ignore' },
		entities: [...entities, ...notificationEntities, ...noteChartEntities],
		synchronize: false,
		migrationsRun: false,
		logging: false,
		installExtensions: false,
	};
}

export function createDataSource(config: DatabaseConfig, timeoutMs = 30000): DataSource {
	return new DataSource(databaseOptions(config, timeoutMs));
}
