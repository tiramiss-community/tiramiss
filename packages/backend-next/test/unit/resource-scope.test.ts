/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { ResourceScope } from '../../src/platform/resource-scope.js';
test('cleans up in reverse order, continues after failure and closes only once', async () => {
	const scope = new ResourceScope();
	const calls: number[] = [];
	scope.defer(async () => {
		calls.push(1);
	});
	scope.defer(async () => {
		calls.push(2);
		throw new Error('close failed');
	});
	scope.defer(async () => {
		calls.push(3);
	});
	await expect(scope.close()).rejects.toThrow();
	await expect(scope.close()).rejects.toThrow();
	expect(calls).toEqual([3, 2, 1]);
});
