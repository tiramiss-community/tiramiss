/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPollEndedHandler } from '../composition/poll-ended-job.js';
import { startPollEndedWorker } from '../platform/job-queue/ended-poll-notification.js';
import { startManagedProcess } from './lifecycle.js';
import type { RuntimeConfig } from '../config/types.js';

export function startWorker(config: RuntimeConfig) {
	// 実ジョブのある queue だけを取得する。汎用の dispatcher や handler のない Worker は作らない。
	return startManagedProcess('worker', config, (resources, reportFailure) => startPollEndedWorker({
		redis: config.redisForJobQueue,
		connectTimeoutMs: config.processes.startupTimeoutMs,
		logger: resources.logger,
		handle: createPollEndedHandler(resources, config),
		reportFailure,
	}));
}
