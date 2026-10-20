/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { idMethods, type IdMethod } from '../platform/id-codec.js';
import { DiagnosticError } from '../platform/diagnostic-error.js';
import type { RedisConfig, RuntimeConfig } from './types.js';

type ObjectValue = Record<string, unknown>;

function object(value: unknown, name: string): ObjectValue {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new DiagnosticError('INVALID_CONFIG', { field: name });
	}
	return value as ObjectValue;
}

function text(value: unknown, name: string, empty = false): string {
	if (typeof value !== 'string' || (!empty && !value)) {
		throw new DiagnosticError('INVALID_CONFIG', { field: name });
	}
	return value;
}

function positive(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
		throw new DiagnosticError('INVALID_CONFIG', { field: name });
	}
	return value as number;
}

function redis(value: unknown, host: string): RedisConfig {
	const source = object(value, 'redis');
	const prefix = text(source.prefix ?? host, 'redis.prefix');
	const db = source.db ?? 0;

	if (!Number.isSafeInteger(db) || (db as number) < 0) {
		throw new DiagnosticError('INVALID_CONFIG', { field: 'redis.db' });
	}

	return {
		...source,
		host: text(source.host, 'redis.host'),
		port: positive(source.port, 'redis.port', 65535),
		password: source.pass === undefined ? undefined : text(source.pass, 'redis.pass', true),
		db: db as number,
		prefix,
		keyPrefix: `${prefix}:`,
		family: (source.family ?? 0) as number,
	} as RedisConfig;
}

export async function loadConfig(
	options: { configFile?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RuntimeConfig> {
	const env = options.env ?? process.env;
	const configDir = fileURLToPath(new URL('../../../../.config/', import.meta.url));
	const path =
		options.configFile ??
		resolve(configDir, env.MISSKEY_CONFIG_YML ?? (env.NODE_ENV === 'test' ? 'test.yml' : 'default.yml'));
	const source = object(load(await readFile(path, 'utf8')), 'configuration');

	let url: URL;
	try {
		url = new URL(text(source.url ?? env.MISSKEY_URL, 'url'));
	} catch {
		throw new DiagnosticError('INVALID_CONFIG', { field: 'url' });
	}
	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new DiagnosticError('INVALID_CONFIG', { field: 'url' });
	}

	const db = object(source.db, 'db');
	const specific = source.backendNext === undefined ? {} : object(source.backendNext, 'backendNext');
	const cache = specific.roleCache === undefined ? {} : object(specific.roleCache, 'backendNext.roleCache');
	const baseRedis = redis(source.redis, url.host);
	const socket = source.socket === undefined ? undefined : text(source.socket, 'socket');
	const port = source.port ?? (env.PORT === undefined ? undefined : Number(env.PORT));

	const id = text(source.id ?? 'aidx', 'id').toLowerCase() as IdMethod;
	if (!idMethods.includes(id)) {
		throw new DiagnosticError('INVALID_CONFIG', { field: 'id' });
	}

	return {
		id,
		url: url.origin,
		roleCache: {
			rolesTtlMs: positive(cache.rolesTtlMs ?? 30000, 'roleCache.rolesTtlMs'),
			assignmentsTtlMs: positive(cache.assignmentsTtlMs ?? 30000, 'roleCache.assignmentsTtlMs'),
			assignmentsMaxEntries: positive(cache.assignmentsMaxEntries ?? 10000, 'roleCache.assignmentsMaxEntries'),
		},
		database: {
			host: text(db.host, 'db.host'),
			port: positive(db.port, 'db.port', 65535),
			database: text(db.db ?? env.DATABASE_DB, 'db.db'),
			username: text(db.user ?? env.DATABASE_USER, 'db.user'),
			password: text(db.pass ?? env.DATABASE_PASSWORD ?? '', 'db.pass', true),
			extra: db.extra === undefined ? {} : object(db.extra, 'db.extra'),
		},
		redis: baseRedis,
		redisForJobQueue: source.redisForJobQueue ? redis(source.redisForJobQueue, url.host) : baseRedis,
		redisForPubsub: source.redisForPubsub ? redis(source.redisForPubsub, url.host) : baseRedis,
		http: {
			socket,
			port: socket && port === undefined ? undefined : positive(port, 'port', 65535),
			chmodSocket: source.chmodSocket === undefined ? undefined : text(source.chmodSocket, 'chmodSocket'),
		},
		processes: {
			workerCount: positive(specific.workerCount ?? 1, 'workerCount'),
			startupTimeoutMs: positive(specific.startupTimeoutMs ?? 30000, 'startupTimeoutMs'),
			shutdownTimeoutMs: positive(specific.shutdownTimeoutMs ?? 30000, 'shutdownTimeoutMs'),
		},
	};
}
