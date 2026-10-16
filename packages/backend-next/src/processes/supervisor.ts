/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger, type Logger } from '../platform/logger.js';
import { isReadyMessage, type ProcessRole } from './protocol.js';
import type { EventEmitter } from 'node:events';
import type { RuntimeConfig } from '../config/types.js';

interface SupervisorDependencies {
	spawn(role: ProcessRole): ChildProcess;
	signals: Pick<EventEmitter, 'on' | 'off'>;
	logger: Logger;
	onReady(children: readonly { role: ProcessRole; pid: number | undefined }[]): void;
}

export function runSupervisor(config: RuntimeConfig, overrides: Partial<SupervisorDependencies> = {}): Promise<number> {
	const dependencies: SupervisorDependencies = {
		spawn: (role) =>
			fork(fileURLToPath(new URL(`../entrypoints/${role}.js`, import.meta.url)), [], {
				stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
			}),
		signals: process,
		logger: createLogger('supervisor'),
		onReady: () => {},
		...overrides,
	};

	return new Promise<number>((resolve) => {
		const children: { child: ChildProcess; role: ProcessRole; ready: boolean; exited: boolean }[] = [];
		let stopping = false;
		let failed = false;
		let announced = false;
		let forceTimer: NodeJS.Timeout | undefined;

		const finish = () => {
			if (!stopping || children.some((child) => !child.exited)) {
				return;
			}

			clearTimeout(startupTimer);
			clearTimeout(forceTimer);
			dependencies.signals.off('SIGTERM', onSignal);
			dependencies.signals.off('SIGINT', onSignal);
			dependencies.logger.info('supervisor.stopped', { failed });
			resolve(failed ? 1 : 0);
		};

		const stop = (failure: boolean) => {
			failed ||= failure;
			if (stopping) {
				finish();
				return;
			}

			stopping = true;
			clearTimeout(startupTimer);
			forceTimer = setTimeout(() => {
				failed = true;
				for (const state of children) {
					if (!state.exited) {
						state.child.kill('SIGKILL');
					}
				}
				finish();
			}, config.processes.shutdownTimeoutMs);
			for (const state of children) {
				if (!state.exited) {
					state.child.kill('SIGTERM');
				}
			}
			finish();
		};

		const onSignal = () => {
			stop(false);
		};
		const startupTimer = setTimeout(() => {
			dependencies.logger.error('startup.timeout');
			stop(true);
		}, config.processes.startupTimeoutMs);
		dependencies.signals.on('SIGTERM', onSignal);
		dependencies.signals.on('SIGINT', onSignal);

		const roles: ProcessRole[] = [
			'http',
			...Array.from({ length: config.processes.workerCount }, (): ProcessRole => 'worker'),
		];

		try {
			for (const role of roles) {
				if (stopping) {
					break;
				}

				const child = dependencies.spawn(role);
				const state = { child, role, ready: false, exited: false };
				children.push(state);

				child.on('error', (error) => {
					dependencies.logger.error('child.error', { role, error });
					// spawn 自体の失敗では exit が来ないため、終了イベントだけを待つと停止できない。
					if (!child.pid) {
						state.exited = true;
					}
					stop(true);
				});

				child.once('exit', (code, signal) => {
					state.exited = true;
					if (code !== null && code !== 0) {
						failed = true;
					}
					if (!stopping) {
						// 正常終了コードでも役割の欠落になる。部分稼働や独自の再起動ループを避け、全体を止める。
						dependencies.logger.error('child.unexpected_exit', { role, code, signal });
						stop(true);
					} else {
						finish();
					}
				});

				child.on('message', (message) => {
					if (stopping || state.exited || !isReadyMessage(message, role)) {
						return;
					}
					state.ready = true;
					// spawn 成功だけでは依存先に接続できたとは言えず、全役割の準備前に ready を通知しない。
					if (!announced && children.length === roles.length && children.every((item) => item.ready && !item.exited)) {
						announced = true;
						clearTimeout(startupTimer);
						dependencies.logger.info('supervisor.ready', {
							children: children.map((item) => ({ role: item.role, pid: item.child.pid })),
						});
						try {
							dependencies.onReady(children.map((item) => ({ role: item.role, pid: item.child.pid })));
						} catch (error) {
							dependencies.logger.error('ready.failed', { error });
							stop(true);
						}
					}
				});
			}
		} catch (error) {
			dependencies.logger.error('spawn.failed', { error });
			stop(true);
		}
	});
}
