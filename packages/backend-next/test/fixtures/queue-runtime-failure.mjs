/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { BullMQQueueManager } from '@mokurokujs/bullmq-adapter';

const mode = process.env.QUEUE_RUNTIME_FAILURE ?? 'observe';
const role = process.env.QUEUE_RUNTIME_ROLE;
const target = process.env.QUEUE_RUNTIME_QUEUE ?? 'deliver';

if (process.env.QUEUE_RUNTIME_SUPERVISOR === '1' && !role) {
	const { loadConfig } = await import('../../built/config/load-config.js');
	const { runSupervisor } = await import('../../built/processes/supervisor.js');
	process.exitCode = await runSupervisor(await loadConfig(), {
		spawn: childRole => {
			const child = fork(fileURLToPath(import.meta.url), [], {
				env: { ...process.env, QUEUE_RUNTIME_ROLE: childRole },
				stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
			});
			process.send?.({ type: 'fixture-spawn', role: childRole, pid: child.pid });
			child.on('message', message => {
				if (message?.type?.startsWith('fixture-')) {
					process.send?.(message);
				}
			});
			// Relay a trigger only to this owned child; the ordinary Supervisor owns its lifetime.
			process.on('message', message => {
				if (message?.type === 'settle-run' && childRole === 'worker' && child.connected) {
					child.send(message);
				}
			});
			return child;
		},
		onReady: children => process.send?.({ type: 'ready', role: 'supervisor', children }),
	});
	if (process.connected) {
		process.disconnect();
	}
} else if (role === 'http') {
	await import('../../built/entrypoints/http.js');
} else {
	const run = Worker.prototype.run;
	const close = Worker.prototype.close;
	const createWorker = BullMQQueueManager.prototype.createWorker;

	BullMQQueueManager.prototype.createWorker = async function (...args) {
		const worker = await createWorker.apply(this, args);
		if (mode === 'partial-startup' && worker.name === target) {
			// Manager readiness observes connections directly, bypassing Worker.waitUntilReady.
			await worker.waitUntilReady();
			process.send?.({ type: 'fixture-startup-failed', queue: worker.name });
			throw new Error('fixture partial startup failure');
		}
		return worker;
	};
	Worker.prototype.close = async function (...args) {
		await close.apply(this, args);
		process.send?.({ type: 'fixture-worker-closed', queue: this.name });
		if (mode === 'cleanup-rejected' && (this.name === target || target === 'all')) {
			throw new Error('fixture cleanup rejection');
		}
	};
	Worker.prototype.run = function (...args) {
		const running = run.apply(this, args);
		// Observe real command and blocking connections rather than guessing CLIENT LIST ordering.
		void Promise.all([this.getBackend().client, this.getBackend().blockingClient]).then(async ([command, blocking]) => {
			process.send?.({ type: 'fixture-connections', queue: this.name, command: String(await command.client('ID')), blocking: String(await blocking.client('ID')) });
		}).catch(() => {});
		if (this.name === target && mode === 'diagnostic') {
			process.on('message', message => {
				if (message?.type === 'emit-diagnostic') {
					this.emit('error', new Error('fixture ordinary diagnostic'));
					setImmediate(() => process.send?.({ type: 'fixture-diagnostic', queue: this.name }));
				}
			});
		}
		if (this.name !== target || !['run-fulfilled', 'run-rejected', 'startup-run-fulfilled'].includes(mode)) {
			return running;
		}
		let settle;
		const signal = new Promise((resolve, reject) => {
			settle = () => mode === 'run-rejected' ? reject(new Error('fixture unexpected run rejection')) : resolve();
		});
		if (mode === 'startup-run-fulfilled') {
			settle();
		} else {
			process.on('message', message => {
				if (message?.type === 'settle-run') {
					settle();
				}
			});
		}
		// The real acquisition loop remains owned by Worker.close during normal cleanup.
		return Promise.race([running, signal]);
	};
	await import('../../built/entrypoints/worker.js');
}
