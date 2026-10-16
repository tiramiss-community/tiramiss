/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { runSupervisor } from '../processes/supervisor.js';
import { createLogger } from '../platform/logger.js';
try {
	const config = await loadConfig();
	process.exitCode = await runSupervisor(config, {
		onReady(children) {
			if (process.send) {
				process.send({ type: 'ready', role: 'supervisor', children });
			}
		},
	});
} catch (error) {
	createLogger('supervisor').error('startup.failed', { error });
	process.exitCode = 1;
}
if (process.connected) {
	process.disconnect?.();
}
