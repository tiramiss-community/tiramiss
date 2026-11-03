/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { testConfig } from '../helpers/database.js';
import { startManagedProcess } from '../../src/processes/lifecycle.js';
const resources = vi.hoisted(() => ({ close: vi.fn(async () => {}), logger: { info: vi.fn(), error: vi.fn() }, failure: new Promise<Error>(() => {}) }));
const initialize = vi.hoisted(() => vi.fn(async () => resources));
const check = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/composition/create-runtime.js', () => ({ createRuntime: initialize }));
vi.mock('../../src/platform/database/check-migrations.js', () => ({ assertMigrationsApplied: check }));

test('does not accept traffic before dependency and history checks, and stops once', async () => {
	const calls: string[] = [];
	check.mockImplementationOnce(async () => {
		calls.push('checked');
	});
	const running = await startManagedProcess('http', testConfig(), async () => {
		expect(calls).toEqual(['checked']);
		calls.push('listening');
		return async () => {
			calls.push('stopped');
		};
	});
	await Promise.all([running.stop(), running.stop()]);
	expect(calls).toEqual(['checked', 'listening', 'stopped']);
});
test('closes initialized resources when history check fails without starting transport', async () => {
	const failure = new Error('pending migration');
	check.mockRejectedValueOnce(failure);
	let listening = false;
	await expect(
		startManagedProcess('http', testConfig(), async () => {
			listening = true;
			return async () => {};
		}),
	).rejects.toBe(failure);
	expect(listening).toBe(false);
});

test('reports a role failure raised during or after start, while shared resources stay healthy', async () => {
	const lost = new Error('worker connection lost');
	let report!: (error: Error) => void;
	const running = await startManagedProcess('worker', testConfig(), async (_resources, reportFailure) => {
		report = reportFailure;
		return async () => {};
	});
	let settled: Error | undefined;
	void running.failure?.then(error => {
		settled = error;
	});
	await Promise.resolve();
	expect(settled).toBeUndefined();
	report(lost);
	expect(await running.failure).toBe(lost);
	await running.stop();
});

test('a failure reported before start returns is delivered once the process is running', async () => {
	const early = new Error('lost while starting');
	const running = await startManagedProcess('worker', testConfig(), async (_resources, reportFailure) => {
		reportFailure(early);
		return async () => {};
	});
	expect(await running.failure).toBe(early);
	await running.stop();
});

test('shared resource failure is still reported when the role reports nothing', async () => {
	const shared = new Error('shared connection lost');
	initialize.mockImplementationOnce(async () => ({ ...resources, failure: Promise.resolve(shared) }));
	const running = await startManagedProcess('http', testConfig(), async () => async () => {});
	expect(await running.failure).toBe(shared);
	await running.stop();
});
