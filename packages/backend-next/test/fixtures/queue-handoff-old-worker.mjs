/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// State-generation double only: this is not an upstream business processor.
const [upstream, input] = process.argv.slice(2);
const { redis, terminalId } = JSON.parse(await readFile(input, 'utf8'));
const requireUpstream = createRequire(upstream === '--recorded' ? resolve('package.json') : resolve(upstream, 'packages/backend/package.json'));
const { Worker, UnrecoverableError } = requireUpstream('bullmq');
if (requireUpstream('bullmq/package.json').version !== '6.3.11') {
	throw new Error('Unexpected fixture BullMQ');
}
const { keyPrefix: _ignored, ...connection } = redis;
void _ignored;
const worker = new Worker('deliver', async job => {
	if (job.id === terminalId) {
		throw new UnrecoverableError('fixture terminal failure');
	}
	throw new Error('fixture transient failure');
}, { connection, prefix: `${redis.prefix}:queue:deliver`, concurrency: 1, autorun: false, settings: { backoffStrategy: () => 60000 } });
worker.on('error', () => {});
let failed = 0;
const stopped = new Promise(resolve => worker.on('failed', () => {
	if (++failed === 2) {
		resolve();
	}
}));
const running = worker.run();
await stopped;
await worker.close();
await running;
