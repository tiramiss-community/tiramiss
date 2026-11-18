/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Logger as TypeOrmLogger } from 'typeorm';
import type { Logger } from '../logger.js';

export function createQueryDiagnostics(logger: Logger): TypeOrmLogger {
	return {
		logQuery() {},
		logQueryError() {},
		logSchemaBuild() {},
		logMigration() {},
		log() {},
		logQuerySlow(durationMs, _query, _parameters, runner) {
			try {
				// SQL literals and bindings can contain private content; the shared logger cannot sanitize their values.
				logger.warn?.('db.query-slow', {
					durationMs,
					...(runner === undefined ? {} : { requestedReplicationMode: runner.getReplicationMode() }),
				});
			} catch {
				// A synchronous diagnostic sink exception must not make a completed write look unsuccessful.
			}
		},
	};
}
