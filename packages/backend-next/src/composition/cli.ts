/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';

export async function runCli(command: string): Promise<number> {
	// Keep configuration failures visible without constructing the HTTP/worker
	// graph: help and ping have no database or Redis operations upstream.
	await loadConfig();

	switch (command) {
		case 'help': {
			console.log('Available commands:');
			console.log('  help - Displays this help message');
			console.log('  ping - Prints pong');
			return 0;
		}
		case 'ping': {
			console.log('pong');
			return 0;
		}
		default: {
			console.error(`Unrecognized command: ${command}`);
			console.error('Use "help" to see available commands.');
			return 1;
		}
	}
}
