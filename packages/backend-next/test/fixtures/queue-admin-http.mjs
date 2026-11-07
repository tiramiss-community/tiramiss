/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Queue } from 'bullmq';
import { runChild } from '../../built/entrypoints/run-child.js';
import { startHttp } from '../../built/processes/http.js';

let release;
const held = new Promise(resolve => {
	release = resolve;
});
process.on('message', message => {
	if (message?.type === 'release') {
		release();
	}
});
const mode = process.env.QUEUE_FIXTURE_GATE;
if (mode === 'startup') {
	const ready = Queue.prototype.waitUntilReady;
	Queue.prototype.waitUntilReady = async function() {
		const client = await ready.call(this);
		if (this.name === 'inbox' && this.opts.connection?.connectionName?.includes(':queue-admin:')) {
			throw new Error('Injected queue administration startup failure');
		}
		return client;
	};
}
const scheduled = new Map();
const setIntervalOriginal = globalThis.setInterval;
const clearIntervalOriginal = globalThis.clearInterval;
globalThis.setInterval = (callback, ms, ...args) => {
	const timer = setIntervalOriginal(callback, ms, ...args);
	if (ms === 10000) {
		scheduled.set(timer, () => callback(...args));
	}
	return timer;
};
globalThis.clearInterval = timer => {
	scheduled.delete(timer); return clearIntervalOriginal(timer);
};
process.on('message', message => {
	if (message?.type === 'probe-timers') {
		for (const callback of scheduled.values()) {
			callback();
		}
		process.send?.({ type: 'timers-probed', registered: scheduled.size });
	}
});
const method = mode === 'stats' ? 'getJobCounts' : mode === 'pause' ? 'pause' : 'getJob';
const original = Queue.prototype[method];
let gated = false;
Queue.prototype[method] = async function(...args) {
	if (!gated && this.name === (mode === 'stats' ? 'deliver' : 'db')) {
		gated = true;
		process.send?.({ type: 'operation-entered', method });
		await held;
	}
	return original.apply(this, args);
};
await runChild('http', async config => {
	const running = await startHttp(config);
	return {
		...running, async stop() {
			process.send?.({ type: 'draining' }); await running.stop(); process.send?.({ type: 'drained' });
		}
	};
});
