/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import pg from 'pg';
import { expect, test } from 'vitest';
import { createDataSource, databaseOptions } from '../../src/platform/database/data-source.js';
import { testConfig } from '../helpers/database.js';

test('sets the upstream statement deadline and permits explicit db.extra overrides', () => {
	const config = testConfig().database;
	expect(createDataSource(config).options.extra).toEqual({ statement_timeout: 10000, connectionTimeoutMillis: 30000 });
	expect(createDataSource({ ...config, extra: { statement_timeout: 0, application_name: 'custom' } }, 123).options.extra)
		.toEqual({ statement_timeout: 0, application_name: 'custom', connectionTimeoutMillis: 123 });
});

test('ignores nullish conditions as the pinned upstream does', () => {
	expect(createDataSource(testConfig().database).options.invalidWhereValuesBehavior).toEqual({ null: 'ignore', undefined: 'ignore' });
});

test('uses upstream scalar int8 Number parsing and preserves the existing int8 array parser', () => {
	expect(pg.types.getTypeParser(20)('9007199254740993')).toBe(9007199254740992);
	expect(pg.types.getTypeParser(1016 as Parameters<typeof pg.types.getTypeParser>[0])('{1,9007199254740993}')).toEqual(['1', '9007199254740993']);
});

test('shared migration options inherit the database timeout and leave runtime nullish-WHERE behavior unset', () => {
	const options = databaseOptions(testConfig().database, 123);
	expect(options.extra).toEqual({ connectionTimeoutMillis: 123 });
	expect(options.invalidWhereValuesBehavior).toBeUndefined();
	expect(databaseOptions({ ...testConfig().database, extra: { statement_timeout: 77 } }, 123).extra)
		.toEqual({ statement_timeout: 77, connectionTimeoutMillis: 123 });
});
