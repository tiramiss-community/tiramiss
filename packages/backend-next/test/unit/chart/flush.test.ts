/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { startNoteChartFlush } from '../../../src/platform/note-chart-flush.js';
afterEach(() => vi.useRealTimers());

test('flushes every twenty minutes, reports failure, and flushes again on close', async () => {
	vi.useFakeTimers();
	const flush = vi.fn().mockRejectedValueOnce(new Error('postgres')).mockResolvedValue(undefined);
	const report = vi.fn();
	const task = startNoteChartFlush(flush, report);
	await vi.advanceTimersByTimeAsync(20 * 60 * 1000 - 1);
	expect(flush).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(report).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
	expect(flush).toHaveBeenCalledTimes(2);
	await task.close();
	expect(flush).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
	expect(flush).toHaveBeenCalledTimes(3);
});

test('close waits for a periodic flush before flushing newly accepted changes', async () => {
	vi.useFakeTimers();
	let finish!: () => void;
	const flush = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => {
		finish = resolve;
	})).mockResolvedValue(undefined);
	const task = startNoteChartFlush(flush, vi.fn());
	await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
	const closing = task.close();
	expect(flush).toHaveBeenCalledTimes(1);
	finish();
	await closing;
	expect(flush).toHaveBeenCalledTimes(2);
});
