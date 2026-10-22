/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DataSource } from 'typeorm';
import { entities } from 'backend-upstream/entities';
import { migrations } from 'backend-upstream/migrations';
import { databaseOptions } from './data-source.js';
import type { DatabaseConfig } from '../../config/types.js';
import { postWorkEntities } from './post-work/schema.js';
import { PostWorkPersistence1792590060271 } from './post-work/migrations.js';

export const internalMigrations = [PostWorkPersistence1792590060271];
export function migrationSources(config: DatabaseConfig) {
	const options = databaseOptions(config);
	return {
		upstream: new DataSource({
			...options,
			schema: 'public',
			entities,
			migrations,
			migrationsTableName: 'migrations',
			migrationsTransactionMode: process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1' ? 'each' : 'all',
		}),
		internal: new DataSource({
			...options,
			entities: postWorkEntities,
			schema: 'backend_internal',
			migrations: internalMigrations,
			migrationsTableName: 'migrations',
			migrationsTransactionMode: 'all',
		}),
	};
}
