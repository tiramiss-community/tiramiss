/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { createLogger } from '../platform/logger.js';
import type { RuntimeConfig } from '../config/types.js';
import type { RunningProcess } from '../processes/lifecycle.js';
import type { ProcessRole } from '../processes/protocol.js';
export async function runChild(
	role: ProcessRole,
	start: (config: RuntimeConfig) => Promise<RunningProcess>,
): Promise<void> {
	const logger = createLogger(role);
	let running: RunningProcess | undefined;
	let stopping = false;
	let failed = false;
	let finishing = false;
	let shutdownMs = 30000;
	let forced: NodeJS.Timeout | undefined;
	let done!: () => void;
	const completed = new Promise<void>((resolve) => {
		done = resolve;
	});
	let startup = setTimeout(() => {
		logger.error('startup.timeout');
		process.exit(1);
	}, 30000);
	const finish = async () => {
		if (finishing) return;
		finishing = true;
		try {
			await running?.stop();
		} catch (error) {
			failed = true;
			logger.error('shutdown.failed', { error });
		}
		clearTimeout(forced);
		clearTimeout(startup);
		process.off('SIGTERM', onSignal);
		process.off('SIGINT', onSignal);
		process.off('disconnect', onDisconnect);
		if (process.connected) process.disconnect?.();
		process.exitCode = failed ? 1 : 0;
		done();
	};
	const stop = (failure: boolean) => {
		failed ||= failure;
		if (stopping) return;
		stopping = true;
		clearTimeout(startup);
		forced = setTimeout(() => {
			logger.error('shutdown.timeout');
			process.exit(1);
		}, shutdownMs);
		if (running) void finish();
	};
	const onSignal = () => {
		stop(false);
	};
	const onDisconnect = () => {
		stop(true);
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);
	process.on('disconnect', onDisconnect);
	try {
		const config = await loadConfig();
		shutdownMs = config.processes.shutdownTimeoutMs;
		if (stopping) {
			await finish();
			return;
		}
		clearTimeout(startup);
		startup = setTimeout(() => {
			logger.error('startup.timeout');
			process.exit(1);
		}, config.processes.startupTimeoutMs);
		running = await start(config);
		clearTimeout(startup);
		if (stopping) await finish();
		else {
			logger.info('process.ready');
			if (process.send) await new Promise<void>((resolve, reject) => {
					process.send!({ type: 'ready', role }, (error) => {
						if (error) reject(error);
						else resolve();
					});
				});
		}
	} catch (error) {
		failed = true;
		logger.error('startup.failed', { error });
		stop(true);
		await finish();
	}
	await completed;
}
