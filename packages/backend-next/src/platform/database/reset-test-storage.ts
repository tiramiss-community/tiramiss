/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { isDeepStrictEqual } from 'node:util';
import type { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../../config/types.js';

/** The operator binds this destructive endpoint to an explicitly provisioned disposable target. */
export function assertTestResetTarget(config: RuntimeConfig, environment: NodeJS.ProcessEnv): void {
	if (environment.NODE_ENV !== 'test') {
		throw new Error('NODE_ENV is not a test');
	}
	const expected = {
		database: { host: config.database.host, port: config.database.port, database: config.database.database },
		redis: { host: config.redis.host, port: config.redis.port, db: config.redis.db ?? 0 },
	};
	let bound: unknown;
	try {
		bound = JSON.parse(environment.BACKEND_NEXT_TEST_RESET_TARGET ?? '');
	} catch {
		throw new Error('Disposable reset target is not bound');
	}
	// Connection overrides or replicas would make the declared reset target incomplete.
	if (!isDeepStrictEqual(bound, expected) || config.database.replicas?.length
		|| ['host', 'port', 'database', 'connectionString'].some(key => key in config.database.extra)
		|| config.redis.path || config.redis.sentinels?.length || config.redis.Connector
		|| (config.redis.tls && ['host', 'port', 'path', 'socket'].some(key => key in config.redis.tls!))) {
		throw new Error('Disposable reset target does not match storage configuration');
	}
}

export async function resetTestDatabase(source: DataSource): Promise<void> {
	await source.transaction(async manager => {
		const tables: { schema: string; table: string }[] = await manager.query(`
			SELECT n.nspname AS schema, c.relname AS table
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname IN ('public', 'backend_internal') AND c.relkind = 'r'
			AND c.relname NOT IN ('migrations', 'typeorm_metadata')
			ORDER BY n.nspname, c.relname`);
		if (tables.length === 0) {
			return;
		}
		const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
		// ONLY prevents inherited/partition descendants in other schemas from being cleared.
		// Omitting CASCADE makes cross-schema foreign keys fail atomically.
		await manager.query(`TRUNCATE TABLE ${tables.map(table => `ONLY ${quote(table.schema)}.${quote(table.table)}`).join(', ')}`);
	});
}
