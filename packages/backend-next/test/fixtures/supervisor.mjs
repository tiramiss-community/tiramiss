/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../built/config/load-config.js';
import { runSupervisor } from '../../built/processes/supervisor.js';
process.exitCode = await runSupervisor(await loadConfig(), {
	spawn: (role) =>
		fork(fileURLToPath(new URL('./child-process.mjs', import.meta.url)), [], {
			env: { ...process.env, FIXTURE_ROLE: role },
			stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
		}),
	onReady: (children) => process.send?.({ type: 'ready', role: 'supervisor', children }),
});
if (process.connected) {
	process.disconnect();
}
