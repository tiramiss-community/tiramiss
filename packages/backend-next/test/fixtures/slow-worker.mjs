/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { runChild } from '../../built/entrypoints/run-child.js';
import { startManagedProcess } from '../../built/processes/lifecycle.js';
import { startPollEndedWorker } from '../../built/platform/job-queue/ended-poll-notification.js';
await runChild('worker', (config) =>
	startManagedProcess('worker', config, (resources, reportFailure) => startPollEndedWorker({
		redis: config.redisForJobQueue,
		connectTimeoutMs: config.processes.startupTimeoutMs,
		logger: resources.logger,
		reportFailure,
		handle: async (job) => {
			process.send?.({ type: 'job-started', noteId: job.noteId });
			await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_JOB_MS ?? 100)));
			process.send?.({ type: 'job-completed', noteId: job.noteId });
		},
	})),
);
