/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { EvaluationClosed, EvaluationInvalidated, EvaluationMemo } from '../../../src/modules/role/evaluation-memo.js';
import { deferred } from './fixtures.js';

test('concurrent identical reads share one pending load and keep independent copies', async () => {
	const memo = new EvaluationMemo();
	const pending = deferred<{ values: string[] }>();
	let calls = 0;
	const load = () => {
		calls++;
		return pending.promise;
	};
	const first = memo.get('user', ['user'], load);
	const second = memo.get('user', ['user'], load);
	const source = { values: ['original'] };
	pending.resolve(source);
	const [a, b] = await Promise.all([first, second]);
	source.values.push('source mutation');
	a.values.push('caller mutation');
	expect(b).toEqual({ values: ['original'] });
	expect(await memo.get('user', ['user'], load)).toEqual({ values: ['original'] });
	expect(calls).toBe(1);
	expect(await memo.get('other', ['other'], async () => 7)).toBe(7);
});

test('failed reads propagate and the next read can succeed', async () => {
	const memo = new EvaluationMemo();
	const error = new Error('read failed');
	await expect(memo.get('key', [], async () => {
		throw error;
	})).rejects.toBe(error);
	expect(await memo.get('key', [], async () => 42)).toBe(42);
});

test.each(['resolve', 'reject'] as const)('invalidating a pending read prevents late %s from replacing or deleting the new read', async (completion) => {
	const memo = new EvaluationMemo();
	const old = deferred<number>();
	const started = deferred<void>();
	const oldRead = memo.get('key', ['changed'], () => {
		started.resolve();
		return old.promise;
	});
	const rejected = expect(oldRead).rejects.toBeInstanceOf(EvaluationInvalidated);
	await started.promise;
	memo.invalidate(['changed']);
	expect(await memo.get('key', ['changed'], async () => 2)).toBe(2);
	if (completion === 'resolve') {
		old.resolve(1);
	} else {
		old.reject(new Error('old failure'));
	}
	await rejected;
	expect(await memo.get('key', ['changed'], async () => 3)).toBe(2);
});

test('invalidation affects only entries with the changed dependency', async () => {
	const memo = new EvaluationMemo();
	await memo.get('first', ['user:a'], async () => 1);
	await memo.get('second', ['user:b'], async () => 2);
	memo.invalidate(['user:a']);
	expect(await memo.get('first', ['user:a'], async () => 3)).toBe(3);
	expect(await memo.get('second', ['user:b'], async () => 4)).toBe(2);
});

test('close rejects both new reads and already pending reads', async () => {
	const memo = new EvaluationMemo();
	const pending = deferred<number>();
	const started = deferred<void>();
	const result = memo.get('key', [], () => {
		started.resolve();
		return pending.promise;
	});
	const rejected = expect(result).rejects.toBeInstanceOf(EvaluationClosed);
	await started.promise;
	memo.close();
	memo.close();
	pending.resolve(1);
	await rejected;
	await expect(memo.get('key', [], async () => 2)).rejects.toBeInstanceOf(EvaluationClosed);
});
