/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createDataSource, databaseOptions } from '../../src/platform/database/data-source.js';
import { testConfig } from '../helpers/database.js';
import type { QueryRunner } from 'typeorm';

function diagnostics() {
	const events: unknown[] = [];
	const logger = {
		info: (event: string, fields?: Record<string, unknown>) => events.push({ level: 'info', event, ...fields }),
		warn: (event: string, fields?: Record<string, unknown>) => events.push({ level: 'warn', event, ...fields }),
		error: (event: string, fields?: Record<string, unknown>) => events.push({ level: 'error', event, ...fields }),
	};
	return { events, logger };
}

test('runtime enables the upstream 300ms slow-query threshold without changing migration logging', () => {
	expect(createDataSource(testConfig().database).options.maxQueryExecutionTime).toBe(300);
	expect(databaseOptions(testConfig().database).maxQueryExecutionTime).toBeUndefined();
});

test('slow diagnostics carry duration and routing without SQL, bindings, or driver errors', () => {
	const { events, logger } = diagnostics();
	const source = createDataSource(testConfig().database, 30000, logger);
	const runner = { getReplicationMode: () => 'slave' } as QueryRunner;
	source.logger.logQuerySlow(321, 'SELECT private_content FROM private_table WHERE token=$1', ['private-token'], runner);
	source.logger.logQuery('SELECT private_content', ['private-token'], runner);
	source.logger.logQueryError('private driver message', 'SELECT private_content', ['private-token'], runner);
	expect(events).toEqual([{ level: 'warn', event: 'db.query-slow', durationMs: 321, replicationMode: 'slave' }]);
});

test('slow diagnostics also work without a runner and cannot turn a completed query into a failure', () => {
	const { events, logger } = diagnostics();
	const source = createDataSource(testConfig().database, 30000, logger);
	source.logger.logQuerySlow(301, 'SELECT 1');
	expect(events).toEqual([{ level: 'warn', event: 'db.query-slow', durationMs: 301 }]);
	const brokenSink = createDataSource(testConfig().database, 30000, { ...logger, warn: () => {
		throw new Error('sink failed'); 
	} });
	expect(() => brokenSink.logger.logQuerySlow(301, 'INSERT INTO example VALUES ($1)', ['private-value'])).not.toThrow();
});
