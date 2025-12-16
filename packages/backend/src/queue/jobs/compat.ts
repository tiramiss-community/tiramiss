/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Bull from 'bullmq';
import type { JobHandlerContext } from '@mokurokujs/core';

/**
 * 既存の ProcessorService が Bull.Job を受け取る形式のまま
 * mokuroku と統合するためのラッパー型。
 *
 * ProcessorService の段階的な移行を可能にする。
 * 新規の ProcessorService は (payload, ctx) 形式で作成し、
 * 既存のものは順次変換していく。
 */
export interface JobLike<TPayload> {
	/** ジョブ ID */
	id: string | undefined;
	/** ジョブ名 */
	name: string;
	/** ペイロード */
	data: TPayload;
	/** 試行回数（0始まり） */
	attemptsMade: number;
	/** タイムスタンプ */
	timestamp: number;
	/** オプション */
	opts: {
		attempts?: number;
	};
	/** ログ出力（互換性のためのスタブ） */
	log(message: string): void;
	/** 進捗更新（互換性のためのスタブ） */
	updateProgress(progress: number): Promise<void>;
}

/**
 * JobHandlerContext から JobLike を生成する。
 * 既存の ProcessorService が Bull.Job<T> を受け取る形式のまま
 * mokuroku のハンドラーから呼び出せるようにする互換レイヤー。
 */
export function toJobLike<TPayload>(
	payload: TPayload,
	ctx: JobHandlerContext,
): JobLike<TPayload> {
	return {
		id: ctx.jobId,
		name: ctx.jobName,
		data: payload,
		attemptsMade: ctx.attempt - 1, // mokuroku は 1 始まり、Bull は 0 始まり
		timestamp: ctx.timestamp.getTime(),
		opts: {
			// 必要に応じて拡張
		},
		// BullMQ の Job.log() / Job.updateProgress() を実際の Job インスタンスに委譲
		log: (message: string) => {
			const bullJob = ctx.rawJob as Bull.Job | undefined;
			if (bullJob?.log) {
				bullJob.log(message);
			}
		},
		updateProgress: async (progress: number) => {
			const bullJob = ctx.rawJob as Bull.Job | undefined;
			if (bullJob?.updateProgress) {
				await bullJob.updateProgress(progress);
			}
		},
	};
}

/**
 * ProcessorService のラッパーを作成するヘルパー。
 * Bull.Job<T> を受け取る既存の ProcessorService を
 * mokuroku の JobHandler<T> として使えるようにする。
 */
export function wrapProcessor<TPayload>(
	processor: (job: Bull.Job<TPayload>) => Promise<unknown>,
): (payload: TPayload, ctx: JobHandlerContext) => Promise<void> {
	return async (payload, ctx) => {
		await processor(toJobLike(payload, ctx) as unknown as Bull.Job<TPayload>);
	};
}
