/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DataSource } from 'typeorm';
import { entities } from 'backend-upstream/entities';
import type { RuntimeConfig } from '../../src/config/types.js';

const source = readFileSync(new URL('../fixtures/database-options/postgres.ts.txt', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'c6879b6b23c5fb1e7518ff0eaa02397791470732389954648f42ab13c0eaaa74');
const logger = source.slice(source.indexOf('function truncateSql('), source.indexOf('export const entities'));
const factory = source.match(/export function createPostgresDataSource\(config: Config\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(factory);
const javascript = ts.transpileModule(`${logger}\n${factory.replace('export ', '')}`, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
}).outputText;

type SqlSink = { info(query: string, parameters?: unknown[]): void; warn(query: string, parameters?: unknown[]): void; error(query: string, parameters?: unknown[]): void };

// The factory and custom SQL logger are literal pinned source. Only external bindings are supplied.
export function createPinnedDiagnosticSource(config: RuntimeConfig, options: {
	environment: string;
	sink: SqlSink;
	disableCache?: boolean;
	logging?: { disableQueryTruncation?: boolean; enableQueryParamLogging?: boolean };
}): DataSource {
	const create = new Function('DataSource', 'entities', 'log', 'process', 'sqlLogger', 'bindThis', `${javascript}\nreturn createPostgresDataSource;`)(
		DataSource, entities, options.environment !== 'production', { env: { NODE_ENV: options.environment } }, options.sink,
		(_target: unknown, _key: string, descriptor: PropertyDescriptor) => descriptor,
	);
	const { database: db } = config;
	return create({
		db: { host: db.host, port: db.port, user: db.username, pass: db.password, db: db.database, extra: db.extra, disableCache: options.disableCache ?? true },
		dbReplications: db.replicas !== undefined,
		dbSlaves: db.replicas?.map(rep => ({ host: rep.host, port: rep.port, user: rep.username, pass: rep.password, db: rep.database })),
		redis: config.redis,
		logging: { sql: options.logging },
	});
}
