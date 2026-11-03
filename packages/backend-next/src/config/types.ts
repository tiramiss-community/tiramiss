/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { IdMethod } from '../platform/id-codec.js';
import type { RedisOptions } from 'ioredis';

export interface DatabaseConfig {
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
	extra: Record<string, unknown>;
}

export interface RedisConfig extends RedisOptions {
	prefix: string;
}

export interface RoleCacheConfig {
	rolesTtlMs: number;
	assignmentsTtlMs: number;
	assignmentsMaxEntries: number;
}

/** 本家と同じ名前・意味の設定キー。未指定は undefined のまま持ち、使う側で既定値を決める。 */
export interface OutboundHttpConfig {
	proxy?: string;
	proxyBypassHosts?: string[];
	allowedPrivateNetworks?: string[];
	outgoingAddress?: string;
	deliverJobConcurrency?: number;
}

/** 本家と同じ名前・意味の deliver queue の設定キー。未指定は undefined のまま持ち、使う側で本家と同じく `??` で既定値を決める。 */
export interface DeliverJobConfig {
	deliverJobPerSec?: number;
	deliverJobMaxAttempts?: number;
}

export interface RuntimeConfig {
	id: IdMethod;
	roleCache: RoleCacheConfig;
	url: string;
	/** 本家どおり、url は正規化前の設定ファイルの値を使う。環境変数で与えた場合は `(undefined)` になる。 */
	userAgent: string;
	outboundHttp: OutboundHttpConfig;
	deliverJob: DeliverJobConfig;
	database: DatabaseConfig;
	redis: RedisConfig;
	redisForJobQueue: RedisConfig;
	redisForPubsub: RedisConfig;
	redisForReactions?: RedisConfig;
	noteMedia?: { mediaProxy: string; externalMediaProxyEnabled: boolean; videoThumbnailGenerator?: string };
	http: { port?: number; socket?: string; chmodSocket?: string };
	processes: { workerCount: number; startupTimeoutMs: number; shutdownTimeoutMs: number };
}
