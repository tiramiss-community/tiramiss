/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { createDataSource } from '../platform/database/data-source.js';
import { reconcileWorkCapacity } from '../platform/database/work-capacity/accounting.js';
import { createLogger } from '../platform/logger.js';

try {
	if (process.argv.slice(2).join(' ') !== '--offline') {
		throw new Error('Stop all services, then run reconcile-work-capacity --offline');
	}
	const config = await loadConfig();
	const source = await createDataSource(config.database).initialize();
	try {
		await reconcileWorkCapacity(source);
		createLogger('reconcile-work-capacity').info('work-capacity.reconciled');
	} finally {
		await source.destroy();
	}
} catch (error) {
	createLogger('reconcile-work-capacity').error('work-capacity.reconcile-failed', { error });
	process.exitCode = 1;
}
