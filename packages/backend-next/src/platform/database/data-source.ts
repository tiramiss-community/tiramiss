/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { entities } from 'backend-upstream/entities';
import { postWorkEntities } from './post-work/schema.js';
import { dispatchEntities } from './post-work/dispatch-schema.js';
import type { DatabaseConfig } from '../../config/types.js';

export function databaseOptions(
	config: DatabaseConfig,
	timeoutMs = 30000,
): Extract<DataSourceOptions, { type: 'postgres' }> {
	return {
		type: 'postgres',
		...config,
		extra: { ...config.extra, connectionTimeoutMillis: timeoutMs },
		entities: [...entities, ...postWorkEntities, ...dispatchEntities],
		synchronize: false,
		migrationsRun: false,
		logging: false,
		installExtensions: false,
	};
}

export function createDataSource(config: DatabaseConfig, timeoutMs = 30000): DataSource {
	return new DataSource(databaseOptions(config, timeoutMs));
}
