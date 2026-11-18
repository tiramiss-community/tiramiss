/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export function startNoteChartFlush(flush: () => Promise<void>, report: (error: unknown) => void) {
	const pending = new Set<Promise<void>>();
	const run = () => {
		const work = flush().catch(report);
		pending.add(work);
		void work.then(() => pending.delete(work));
	};
	const timer = setInterval(run, 20 * 60 * 1000);
	timer.unref();
	return {
		async close(): Promise<void> {
			clearInterval(timer);
			await Promise.all([...pending]);
			await flush().catch(report);
		},
	};
}
