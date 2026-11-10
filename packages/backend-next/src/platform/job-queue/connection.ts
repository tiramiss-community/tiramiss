/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MetricsTime } from 'bullmq';
import type { RedisOptions, RedisQueueBackend } from 'bullmq';
import type { RedisConfig } from '../../config/types.js';

/**
 * 本家 queue/const.ts の baseQueueOptions。既存のジョブを読めるよう、キューごとの prefix は本家と同じ式で作る。
 * BullMQ は ioredis の keyPrefix と併用できないため、本家と同じく外す。
 */
export function baseQueueOptions(redis: RedisConfig, queueName: string, connectTimeoutMs: number) {
	const { keyPrefix: _keyPrefix, ...options } = redis;
	const connection: RedisOptions = {
		...options,
		connectTimeout: connectTimeoutMs,
		// 本家は BullMQ の既定の retryStrategy（1〜20 秒の指数待ちで無期限）で再接続し続ける。他の必須接続と同じく再接続せず、切断は子の停止として扱う。
		retryStrategy: () => null,
		// BullMQ は待ち受け用の接続に null を求める。再接続しないため、切断後のコマンドは待たずに失敗する。
		maxRetriesPerRequest: null,
	};
	return { connection, prefix: redis.prefix ? `${redis.prefix}:queue:${queueName}` : `queue:${queueName}` };
}

/** 本家 queue/const.ts の baseWorkerOptions。管理画面の統計（#163）が読む metrics も本家と同じく記録する。 */
export function baseWorkerOptions(redis: RedisConfig, queueName: string, connectTimeoutMs: number) {
	return { ...baseQueueOptions(redis, queueName, connectTimeoutMs), metrics: { maxDataPoints: MetricsTime.ONE_WEEK } };
}

/**
 * Queue・Worker が持つすべての Redis 接続の終了を知らせる。
 * BullMQ は接続の失敗を握りつぶして取得を再試行し続けるため、'error' や run() の結果だけでは失った接続を検知できない。
 */
export async function onConnectionEnd(target: { getBackend(): RedisQueueBackend }, listener: () => void): Promise<void> {
	const backend = target.getBackend();
	const clients = [await backend.client];
	if (backend.blockingClient !== undefined) {
		clients.push(await backend.blockingClient);
	}
	for (const client of clients) {
		client.on('end', listener);
		if (client.status === 'end') {
			listener();
		}
	}
}
