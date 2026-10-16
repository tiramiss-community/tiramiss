/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { startManagedProcess } from './lifecycle.js';
import type { RuntimeConfig } from '../config/types.js';
export function startWorker(config: RuntimeConfig) {
	// Job consumers are added when a real job contract is implemented.
	return startManagedProcess('worker', config, async () => async () => {});
}
