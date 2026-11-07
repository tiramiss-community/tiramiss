/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { PlannedTimeline } from '../modules/note/public.js';

interface TimelinePipeline {
	lpush(key: string, id: string): unknown;
	ltrim(key: string, start: number, end: number): unknown;
	exec(): Promise<[Error | null, unknown][] | null>;
}

export function createTimelineCache(redis: {
	pipeline(): TimelinePipeline;
	lindex(key: string, index: number): Promise<string | null>;
	lpush(key: string, id: string): Promise<number>;
}, ports: { createdAtFromId(id: string): number; currentTime(): number; random(): number }) {
	return {
		begin(id: string) {
			const pipeline = redis.pipeline();
			const old: Promise<unknown>[] = [];
			const finish = async (work: Promise<unknown>[]) => {
				const results = await Promise.allSettled(work);
				const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
				if (errors.length > 0) {
					throw new AggregateError(errors, 'Timeline cache update failed');
				}
			};
			return {
				push({ name, maxlen }: PlannedTimeline): void {
					const key = `list:${name}`;
					if (ports.createdAtFromId(id) > ports.currentTime() - 180000) {
						pipeline.lpush(key, id);
						if (ports.random() < 0.1) {
							pipeline.ltrim(key, 0, maxlen - 1);
						}
					} else {
						// 古い投稿はpipelineのexecより先に独立して開始する。本家どおりtrimしない。
						const work = redis.lindex(key, -1).then(async tail => {
							if (tail === null || ports.createdAtFromId(id) > ports.createdAtFromId(tail)) {
								await redis.lpush(key, id);
							}
						});
						old.push(work);
						void work.catch(() => {});
					}
				},
				async flush(): Promise<void> {
					await finish([...old, (async () => {
						const results = await pipeline.exec();
						if (results === null) {
							throw new Error('Timeline pipeline returned no result');
						}
						const errors = results.flatMap(([error]) => error === null ? [] : [error]);
						if (errors.length > 0) {
							throw new AggregateError(errors, 'Timeline pipeline commands failed');
						}
					})()]);
				},
				// facts取得の途中で失敗しても、開始済みの古い投稿の直接更新は終了まで待つ。
				drain: () => finish(old),
			};
		},
	};
}
