/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
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
export interface RuntimeConfig {
	url: string;
	database: DatabaseConfig;
	redis: RedisConfig;
	redisForJobQueue: RedisConfig;
	redisForPubsub: RedisConfig;
	http: { port?: number; socket?: string; chmodSocket?: string };
	processes: { workerCount: number; startupTimeoutMs: number; shutdownTimeoutMs: number };
}
