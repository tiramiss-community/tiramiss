/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { runChild } from '../../built/entrypoints/run-child.js';
import { startManagedProcess } from '../../built/processes/lifecycle.js';
import { createBusinessJobDefinitions } from '../../built/platform/job-queue/business-jobs.js';
import { createBusinessJobRuntime } from '../../built/platform/job-queue/runtime.js';
import { createPollEndedProcessor } from '../../built/platform/job-queue/ended-poll-notification.js';
await runChild('worker', config => startManagedProcess('worker', config, async (resources, reportFailure) => {
	const options = { redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs };
	const definitions = createBusinessJobDefinitions(options);
	const owner = createBusinessJobRuntime({ ...options, onError: event => {
		if (['connection-ended', 'run-fulfilled', 'run-rejected'].includes(event.reason)) {
			reportFailure(event.error);
		}
	} });
	owner.runtime.handle(definitions.pollEnded, createPollEndedProcessor(async job => {
		process.send?.({ type: 'job-started', noteId: job.noteId });
		await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_JOB_MS ?? 100)));
		process.send?.({ type: 'job-completed', noteId: job.noteId });
	}, resources.logger), { defaultForQueue: true });
	try {
		await owner.runtime.start({ timeout: options.connectTimeoutMs });
	} catch (error) {
		await owner.stop();
		throw error;
	}
	return () => owner.stop();
}));
