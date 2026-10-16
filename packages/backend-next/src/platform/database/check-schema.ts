/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from '../diagnostic-error.js';
import { migrationSources } from './migration-sources.js';
import type { DatabaseConfig } from '../../config/types.js';

export async function assertSchemaMatches(config: DatabaseConfig): Promise<void> {
	for (const [kind, source] of Object.entries(migrationSources(config))) {
		try {
			await source.initialize();
			// Schema builder reads only tables owned by the registered entity metadata.
			// log() computes proposed DDL in memory; it must never be executed here.
			const diff = await source.driver.createSchemaBuilder().log();
			if (diff.upQueries.length || diff.downQueries.length) {
				throw new DiagnosticError('SCHEMA_DRIFT', {
					scope: kind,
					up: diff.upQueries.map((query) => query.query),
					down: diff.downQueries.map((query) => query.query),
				});
			}
		} finally {
			if (source.isInitialized) {
				await source.destroy();
			}
		}
	}
}
