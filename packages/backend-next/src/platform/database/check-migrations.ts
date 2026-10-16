/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from '../diagnostic-error.js';
import { migrationSources } from './migration-sources.js';
import type { DatabaseConfig } from '../../config/types.js';
export async function assertMigrationsApplied(config: DatabaseConfig): Promise<void> {
	const sources = migrationSources(config);
	for (const [kind, source] of Object.entries(sources)) {
		try {
			await source.initialize();
			const schema = kind === 'upstream' ? 'public' : 'backend_internal';
			// showMigrations() は履歴テーブルを作り得るため、DB を変更できない通常起動では使わない。
			const [table] = await source.query('SELECT to_regclass($1) AS name', [`${schema}.migrations`]);
			if (!table.name) throw new DiagnosticError('MIGRATION_HISTORY_MISSING', { scope: kind, table: `${schema}.migrations` });
			const rows: { name: string; timestamp: string | number }[] = await source.query(
				`SELECT name, timestamp FROM ${schema}.migrations`,
			);
			const applied = new Set(rows.map((row) => `${row.name}:${row.timestamp}`));
			const missing = source.migrations.filter((migration) => {
				const name = migration.name ?? migration.constructor.name;
				return !applied.has(`${name}:${name.slice(-13)}`);
			});
			if (missing.length) throw new DiagnosticError('PENDING_MIGRATIONS', {
					scope: kind,
					count: missing.length,
					migrations: missing.map((migration) => migration.name ?? migration.constructor.name),
				});
		} finally {
			if (source.isInitialized) await source.destroy();
		}
	}
}
