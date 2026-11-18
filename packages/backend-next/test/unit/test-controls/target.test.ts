/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { assertTestResetTarget } from '../../../src/platform/database/reset-test-storage.js';
import { testConfig } from '../../helpers/database.js';

function environment(config = testConfig()): NodeJS.ProcessEnv {
	return { NODE_ENV: 'test', BACKEND_NEXT_TEST_RESET_TARGET: JSON.stringify({
		database: { host: config.database.host, port: config.database.port, database: config.database.database },
		redis: { host: config.redis.host, port: config.redis.port, db: config.redis.db ?? 0 },
	}) };
}

test('explicit matching binding accepts dedicated DB0 and never infers a target from NODE_ENV', () => {
	expect(() => assertTestResetTarget(testConfig(), environment())).not.toThrow();
	expect(() => assertTestResetTarget(testConfig(), { NODE_ENV: 'test' })).toThrow();
});

test.each(['host', 'port', 'database', 'connectionString'])('rejects a database connection override in extra.%s', key => {
	const config = testConfig();
	config.database.extra[key] = 'override';
	expect(() => assertTestResetTarget(config, environment(config))).toThrow();
});

test('stale binding, replica, sentinel and unix socket cannot redirect a bound reset', () => {
	for (const change of [
		(config: ReturnType<typeof testConfig>) => {
			config.database.port++;
		},
		(config: ReturnType<typeof testConfig>) => {
			config.redis.db = 1;
		},
		(config: ReturnType<typeof testConfig>) => {
			config.database.replicas = [config.database];
		},
		(config: ReturnType<typeof testConfig>) => {
			config.redis.tls = { host: 'other-host' } as never;
		},
		(config: ReturnType<typeof testConfig>) => {
			config.redis.path = '/tmp/redis.sock';
		},
		(config: ReturnType<typeof testConfig>) => {
			config.redis.sentinels = [{ host: 'elsewhere', port: 26379 }];
		},
	]) {
		const config = testConfig();
		const env = environment(config);
		change(config);
		expect(() => assertTestResetTarget(config, env)).toThrow();
	}
});
