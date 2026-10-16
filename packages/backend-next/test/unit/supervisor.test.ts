/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { runSupervisor } from '../../src/processes/supervisor.js';
import { testConfig } from '../helpers/database.js';
import type { ChildProcess } from 'node:child_process';
class Child extends EventEmitter {
	exitCode: number | null = null;
	signalCode: string | null = null;
	signals: string[] = [];
	constructor(
		readonly role: string,
		readonly stubborn = false,
	) {
		super();
	}
	kill(signal: string) {
		this.signals.push(signal);
		if (!this.stubborn || signal === 'SIGKILL') {
			this.signalCode = signal;
			queueMicrotask(() => this.emit('exit', null, signal));
		}
		return true;
	}
}
const logger = { info() {}, error() {} };
test('waits for every ready, then stops siblings on even an unexpected clean exit', async () => {
	const signals = new EventEmitter();
	const children: Child[] = [];
	let ready = false;
	const completion = runSupervisor(testConfig(), {
		signals,
		logger,
		spawn: (role) => {
			const child = new Child(role);
			children.push(child);
			return child as unknown as ChildProcess;
		},
		onReady: () => {
			ready = true;
		},
	});
	expect(children.map((c) => c.role)).toEqual(['http', 'worker']);
	children[0].emit('message', { type: 'ready', role: 'http' });
	expect(ready).toBe(false);
	children[1].emit('message', { type: 'ready', role: 'worker' });
	expect(ready).toBe(true);
	children[0].exitCode = 0;
	children[0].emit('exit', 0, null);
	expect(await completion).toBe(1);
	expect(children[1].signals).toEqual(['SIGTERM']);
	expect(children).toHaveLength(2);
});
test('bounds startup and kills a child which ignores shutdown', async () => {
	const config = testConfig();
	config.processes.startupTimeoutMs = 20;
	config.processes.shutdownTimeoutMs = 20;
	const children: Child[] = [];
	const completion = runSupervisor(config, {
		signals: new EventEmitter(),
		logger,
		spawn: (role) => {
			const c = new Child(role, true);
			children.push(c);
			return c as unknown as ChildProcess;
		},
	});
	expect(await completion).toBe(1);
	expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
});
test('stops normally during startup and recovers partially spawned children on failure', async () => {
	const signals = new EventEmitter();
	const children: Child[] = [];
	const completion = runSupervisor(testConfig(), {
		signals,
		logger,
		spawn: (role) => {
			const c = new Child(role);
			children.push(c);
			return c as unknown as ChildProcess;
		},
	});
	signals.emit('SIGTERM');
	expect(await completion).toBe(0);
	let count = 0;
	const first = new Child('http');
	expect(
		await runSupervisor(testConfig(), {
			signals,
			logger,
			spawn: () => {
				if (count++) throw new Error('spawn failed');
				return first as unknown as ChildProcess;
			},
		}),
	).toBe(1);
	expect(first.signals).toEqual(['SIGTERM']);
});
