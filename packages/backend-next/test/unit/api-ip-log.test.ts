/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import corpus from '../../../../docs/superpowers/compatibility/api-ip-log/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/api-ip-log/observations.json' with { type: 'json' };
import { createApiIpLog } from '../../src/platform/api-ip-log.js';

afterEach(() => vi.useRealTimers());

test('disabled logging and anonymous calls never reserve histories or insert', async () => {
	const rows: unknown[] = [];
	let enabled = false;
	const log = createApiIpLog({ enabled: async () => enabled, insert: row => {
		rows.push(row); return Promise.resolve();
	}, now: () => new Date(0), onError() {} });
	log.record(null, '1.2.3.4');
	log.record('alice', '1.2.3.4');
	await log.idle();
	expect(rows).toEqual([]);
	enabled = true;
	log.record('alice', '1.2.3.4');
	await log.idle();
	expect(rows).toEqual([{ userId: 'alice', ip: '1.2.3.4', createdAt: new Date(0) }]);
	await log.close();
});

test('suppresses per user/IP until hourly clear, independently of write completion', async () => {
	vi.useFakeTimers();
	const rows: unknown[] = [];
	const log = createApiIpLog({ enabled: async () => true, insert: async row => {
		rows.push(row);
	}, now: () => new Date(0), onError() {} });
	for (const [user, ip] of [['alice', 'a'], ['alice', 'a'], ['alice', 'b'], ['bob', 'a']]) {
		log.record(user, ip);
	}
	await log.idle();
	expect(rows).toHaveLength(3);
	await vi.advanceTimersByTimeAsync(3599999);
	log.record('alice', 'a');
	await log.idle();
	expect(rows).toHaveLength(3);
	await vi.advanceTimersByTimeAsync(1);
	log.record('alice', 'a');
	await log.idle();
	expect(rows).toHaveLength(4);
	await log.close();
	expect(vi.getTimerCount()).toBe(0);
});

test.each(['sync', 'async'] as const)('%s insertion failure is contained and still suppresses retry', async kind => {
	let attempts = 0;
	const errors: unknown[] = [];
	const log = createApiIpLog({ enabled: async () => true, insert() {
		attempts++; if (kind === 'sync') {
			throw Error('write');
		} return Promise.reject(Error('write'));
	}, now: () => new Date(0), onError: error => errors.push(error) });
	log.record('alice', 'a');
	await log.idle();
	log.record('alice', 'a');
	await log.idle();
	expect(attempts).toBe(1);
	expect(errors).toHaveLength(1);
	await log.close();
});

test('close cancels the timer, drains accepted inserts and rejects later records', async () => {
	vi.useFakeTimers();
	let finish!: () => void;
	let inserted = 0;
	const log = createApiIpLog({ enabled: async () => true, insert: () => {
		inserted++; return new Promise<void>(resolve => {
			finish = resolve;
		});
	}, now: () => new Date(0), onError() {} });
	log.record('alice', 'a');
	await Promise.resolve();
	let closed = false;
	const closing = log.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	log.record('bob', 'b');
	finish();
	await closing;
	expect(inserted).toBe(1);
});

for (const item of corpus.cases) {
	test(`matches pinned source attempts and stored rows: ${item.id}`, async () => {
		vi.useFakeTimers();
		const expected = observations.cases.find(observation => observation.id === item.id)!;
		let attempts = 0;
		const rows: { userId: string; ip: string; createdAt: string }[] = [];
		const log = createApiIpLog({ enabled: async () => item.enabled, now: () => new Date(0), onError() {}, insert(row) {
			attempts++;
			if (item.failure === 'sync') {
				throw Error('write');
			}
			if (item.failure === 'async') {
				return Promise.reject(Error('write'));
			}
			if (!rows.some(saved => saved.userId === row.userId && saved.ip === row.ip)) {
				rows.push({ ...row, createdAt: row.createdAt.toISOString() });
			}
			return Promise.resolve();
		} });
		for (const [index, [userId, ip]] of item.calls.entries()) {
			if (index === item.clearBefore) {
				await vi.advanceTimersByTimeAsync(3600000);
			}
			log.record(userId, ip!);
			await log.idle();
		}
		expect(attempts).toBe(expected.attempts);
		expect(rows).toEqual(expected.rows);
		await log.close();
	});
}
