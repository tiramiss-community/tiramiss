/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import ts from 'typescript';
import { DataSource } from 'typeorm';
import { entities } from 'backend-upstream/entities';
import type { DatabaseConfig } from '../../src/config/types.js';

// Literal fixed-source factory, with only its external bindings supplied here.
const source = readFileSync(new URL('../fixtures/database-options/postgres.ts.txt', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'c6879b6b23c5fb1e7518ff0eaa02397791470732389954648f42ab13c0eaaa74');
const factory = source.match(/export function createPostgresDataSource\(config: Config\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(factory);
const parser = source.match(/^pg\.types\.setTypeParser\(20, Number\);$/m)?.[0];
assert.ok(parser);
const parserCode = parser;
const javascript = ts.transpileModule(factory.replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

export function createPinnedDatabaseSource(config: DatabaseConfig): DataSource {
	new Function('pg', parserCode)(pg);
	// Production env and disabled cache avoid the source's test-only schema drop and Redis cache.
	// Registered entities are the synchronized subset; no ORM/business implementation is replaced.
	const create = new Function('DataSource', 'entities', 'log', 'MyCustomLogger', 'process', `${javascript}\nreturn createPostgresDataSource;`)(
		DataSource, entities, false, undefined, { env: { NODE_ENV: 'production' } },
	);
	return create({ db: { host: config.host, port: config.port, user: config.username, pass: config.password, db: config.database, extra: config.extra, disableCache: true } });
}
