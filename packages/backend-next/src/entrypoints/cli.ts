/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { runCli } from '../composition/cli.js';

try {
	process.exitCode = await runCli(process.argv[2] ?? 'help');
} catch {
	console.error('CLI initialization failed.');
	process.exitCode = 1;
}
