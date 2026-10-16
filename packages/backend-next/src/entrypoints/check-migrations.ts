/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { assertMigrationsApplied } from '../platform/database/check-migrations.js';
import { createLogger } from '../platform/logger.js';
try {
	const config = await loadConfig();
	await assertMigrationsApplied(config.database);
	createLogger('check-migrations').info('check-migrations.complete');
} catch (error) {
	createLogger('check-migrations').error('check-migrations.failed', { error });
	process.exitCode = 1;
}
