/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { startQueueWorkers } from '../composition/queue-workers.js';
import { startManagedProcess } from './lifecycle.js';
import type { RuntimeConfig } from '../config/types.js';

export function startWorker(config: RuntimeConfig) {
	return startManagedProcess('worker', config, (resources, reportFailure) => startQueueWorkers(resources, config, reportFailure));
}
