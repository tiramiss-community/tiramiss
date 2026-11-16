/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { checkConnections } from '../platform/connect-check.js';

try {
	const result = await checkConnections(await loadConfig());
	console.log(JSON.stringify(result));
	process.exitCode = result.ready ? 0 : 1;
} catch {
	console.error('Connection check initialization failed.');
	process.exitCode = 1;
}
