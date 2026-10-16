/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { migrateDatabase } from '../platform/database/migrate.js';
import { createLogger } from '../platform/logger.js';
try {
	const config = await loadConfig();
	await migrateDatabase(config.database);
	createLogger('migrate').info('migrate.complete');
} catch (error) {
	createLogger('migrate').error('migrate.failed', { error });
	process.exitCode = 1;
}
