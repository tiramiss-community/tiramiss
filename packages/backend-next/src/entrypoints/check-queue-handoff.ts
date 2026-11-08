/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../config/load-config.js';
import { inspectQueueHandoff } from '../platform/job-queue/handoff.js';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--stopped') {
	process.stderr.write(`${JSON.stringify({ ready: false, code: args.length === 0 ? 'STOPPED_ATTESTATION_REQUIRED' : 'INVALID_ARGUMENTS' })}\n`);
	process.exitCode = 1;
} else {
	try {
		const config = await loadConfig();
		const report = await inspectQueueHandoff({ redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs });
		process.stdout.write(`${JSON.stringify(report)}\n`);
		if (!report.ready) {
			process.exitCode = 1;
		}
	} catch {
		process.stderr.write(`${JSON.stringify({ ready: false, code: 'QUEUE_HANDOFF_INSPECTION_FAILED' })}\n`);
		process.exitCode = 1;
	}
}
