/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { assertSchemaMatches } from '../platform/database/check-schema.js';
import { createLogger } from '../platform/logger.js';
try {
	const config = await loadConfig();
	await assertSchemaMatches(config.database);
	createLogger('check-schema').info('check-schema.complete');
} catch (error) {
	createLogger('check-schema').error('check-schema.failed', { error });
	process.exitCode = 1;
}
