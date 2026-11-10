/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { UnrecoverableError } from 'bullmq';
import { createDigest } from '../../modules/federation/public.js';
import { DiagnosticError } from '../diagnostic-error.js';
import { baseWorkerOptions } from './connection.js';
import type { JobHandler } from '@mokurokujs/core';
import type { RedisConfig } from '../../config/types.js';
import type { DeliverJob, DeliverJobOutcome, DeliverBatch } from '../../modules/federation/public.js';
import type { Logger } from '../logger.js';

export const DELIVER = 'deliver';

/** 本家 QueueService の job 名。最初の一致だけを置き換えるため、`http://` や `/inboxes` の `es` は残る。 */
export function deliverJobName(to: string): string {
	return to.replace('https://', '').replace('/inbox', '');
}

/** 本家 QueueService.deliverMany の addBulk の引数。本文と digest は 1 回だけ作り、全 job で同じ値を使う。 */
export function deliverJobs(batch: DeliverBatch, config: { deliverJobMaxAttempts?: number }) {
	const content = JSON.stringify(batch.activity);
	const digest = createDigest(content);
	const opts = {
		attempts: config.deliverJobMaxAttempts ?? 12,
		// 待ち時間は Worker の settings.backoffStrategy（httpRelatedBackoff）が決める。
		backoff: { type: 'custom' as const },
		removeOnComplete: { age: 3600 * 24 * 7, count: 30 },
		removeOnFail: { age: 3600 * 24 * 7, count: 100 },
	};
	return Array.from(batch.inboxes, ([to, isSharedInbox]) => ({
		name: deliverJobName(to),
		data: { user: batch.user, content, digest, to, isSharedInbox } satisfies DeliverJob,
		opts,
	}));
}

/** 本家 QueueProcessorService の httpRelatedBackoff。`attemptsMade` は BullMQ が渡す、失敗した試行の回数。 */
export function httpRelatedBackoff(attemptsMade: number, random: () => number = Math.random): number {
	const baseDelay = 60 * 1000;
	const maxBackoff = 8 * 60 * 60 * 1000;
	let backoff = (Math.pow(2, attemptsMade) - 1) * baseDelay;
	backoff = Math.min(backoff, maxBackoff);
	backoff += Math.round(backoff * random() * 0.2);
	return backoff;
}

/** 本家 QueueProcessorService の deliver Worker の設定。 */
export function deliverWorkerOptions(redis: RedisConfig, connectTimeoutMs: number, config: { deliverJobConcurrency?: number; deliverJobPerSec?: number }) {
	return {
		...baseWorkerOptions(redis, DELIVER, connectTimeoutMs),
		autorun: false,
		concurrency: config.deliverJobConcurrency ?? 128,
		limiter: { max: config.deliverJobPerSec ?? 128, duration: 1000 },
		settings: { backoffStrategy: (attemptsMade: number) => httpRelatedBackoff(attemptsMade) },
	};
}

export function parseDeliverJob(data: unknown): DeliverJob {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		throw new DiagnosticError('INVALID_JOB_PAYLOAD', { queue: DELIVER });
	}
	const { user, content, digest, to, isSharedInbox } = data as Record<string, unknown>;
	const userId = typeof user === 'object' && user !== null ? (user as Record<string, unknown>).id : undefined;
	if (typeof userId !== 'string' || typeof content !== 'string' || typeof digest !== 'string' || typeof to !== 'string' || typeof isSharedInbox !== 'boolean') {
		throw new DiagnosticError('INVALID_JOB_PAYLOAD', { queue: DELIVER });
	}
	return { user: { id: userId }, content, digest, to, isSharedInbox };
}

/**
 * 処理の結果を BullMQ のジョブの結果へ写す。再試行しない失敗は UnrecoverableError、再試行する失敗は分類した例外のまま投げる。
 */
export function settleDeliverJob(outcome: DeliverJobOutcome): string {
	if (outcome.kind === 'done') {
		return outcome.result;
	}
	if (outcome.kind === 'stop') {
		throw new UnrecoverableError(outcome.message);
	}
	throw outcome.error;
}

/** 保存済み payload を検証して process へ渡す。 */
export function createDeliverProcessor(process: (job: DeliverJob) => Promise<DeliverJobOutcome>, logger: Logger): JobHandler<DeliverJob, string> {
	return async (payload, context) => {
		let reason: string | undefined;
		try {
			const outcome = await process(parseDeliverJob(payload));
			if (outcome.kind === 'stop') {
				reason = outcome.message;
			}
			return settleDeliverJob(outcome);
		} catch (error) {
			// 本家 runQueueJob と同じく試行ごとに記録し、元の例外のまま BullMQ へ返す。
			// logger は例外のメッセージを出さないため、自分で作った停止の理由だけを別に残す。
			const to = (payload as { to?: unknown } | null)?.to;
			logger.error('job.failed', { queue: DELIVER, jobId: context.jobId, jobName: context.jobName, attemptsMade: context.attempt - 1, to, reason, error });
			throw error;
		}
	};
}
