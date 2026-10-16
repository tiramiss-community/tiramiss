/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DataSource } from 'typeorm';
import { migrations } from 'backend-upstream/migrations';
import { databaseOptions } from './data-source.js';
import type { DatabaseConfig } from '../../config/types.js';
export const internalMigrations = [];
export function migrationSources(config: DatabaseConfig) {
	const options = databaseOptions(config);
	return {
		upstream: new DataSource({
			...options,
			schema: 'public',
			migrations,
			migrationsTableName: 'migrations',
			migrationsTransactionMode: process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1' ? 'each' : 'all',
		}),
		internal: new DataSource({
			...options,
			entities: [],
			schema: 'backend_internal',
			migrations: internalMigrations,
			migrationsTableName: 'migrations',
			migrationsTransactionMode: 'all',
		}),
	};
}
