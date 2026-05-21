/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type ShutdownTask = (signal?: NodeJS.Signals) => Promise<void> | void;

const tasks: ShutdownTask[] = [];
let shutdownPromise: Promise<void> | null = null;

export function registerShutdownTask(task: ShutdownTask): void {
	tasks.push(task);
}

export function runLocalShutdown(signal?: NodeJS.Signals): Promise<void> {
	if (shutdownPromise) {
		return shutdownPromise;
	}

	shutdownPromise = (async () => {
		for (const task of tasks) {
			try {
				await task(signal);
			} catch { }
		}
	})();

	return shutdownPromise;
}
