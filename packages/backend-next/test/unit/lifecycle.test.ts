/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { testConfig } from '../helpers/database.js';
import { startManagedProcess } from '../../src/processes/lifecycle.js';
const resources = vi.hoisted(() => ({ close: vi.fn(async () => {}), logger: { info: vi.fn(), error: vi.fn() } }));
const initialize = vi.hoisted(() => vi.fn(async () => resources));
const check = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/composition/create-runtime.js', () => ({ createRuntime: initialize }));
vi.mock('../../src/platform/database/work-capacity/accounting.js', () => ({ assertWorkCapacity: async () => {} }));
vi.mock('../../src/platform/work-capacity-monitor.js', () => ({ startWorkCapacityMonitor: async () => async () => {} }));
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
