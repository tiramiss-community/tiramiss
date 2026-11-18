/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { createTestControlsHttp } from '../../../src/composition/test-controls-http.js';
import { testConfig } from '../../helpers/database.js';

const logger = { error: vi.fn() };
const fixture = () => ({ logger, dataSource: { manager: {} }, redis: {}, meta: {} });
const post = (app: ReturnType<typeof createTestControlsHttp>, path: string, input: unknown) => app.request(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
afterEach(() => vi.unstubAllEnvs());

test('test endpoint retains default fields, nullable values, unknown fields and id validation', async () => {
	const app = createTestControlsHttp(fixture() as never, testConfig());
	const valid = await post(app, 'test', { required: true, nullableDefault: null, extra: 'kept' });
	expect(valid.status).toBe(200);
	expect(await valid.json()).toEqual({ required: true, default: 'hello', nullableDefault: null, extra: 'kept' });
	for (const input of [{}, { required: 'true' }, { required: true, id: 'bad-id' }, { required: true, string: null }]) {
		const response = await post(app, 'test', input);
		expect(response.status).toBe(400);
		expect(await response.json()).toHaveProperty('error.code', 'INVALID_PARAM');
	}
});

test.each(['production', 'development', 'testing', 'test'])('reset rejects %s without explicit dedicated targets before touching storage', async environment => {
	vi.stubEnv('NODE_ENV', environment);
	vi.stubEnv('BACKEND_NEXT_TEST_RESET_TARGET', '');
	const app = createTestControlsHttp(fixture() as never, testConfig());
	const response = await post(app, 'reset-db', {});
	expect(response.status).toBe(500);
	expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
});

test('test endpoint accepts and rejects the same finite inputs as the literal pinned schema', async () => {
	const { pinnedTestInput } = await import('../../helpers/pinned-test-controls.js');
	const app = createTestControlsHttp(fixture() as never, testConfig());
	for (const input of [{}, { required: true }, { required: false, id: 'abc123', extra: 2 }, { required: true, nullableDefault: null }, { required: null }, { required: true, id: 'bad-id' }, { required: true, default: null }, { required: true, string: 2 }]) {
		const expected = structuredClone(input);
		const valid = pinnedTestInput(expected);
		const response = await post(app, 'test', input);
		expect(response.status).toBe(valid ? 200 : 400);
		if (valid) {
			expect(await response.json()).toEqual(expected);
		}
	}
});

test('reset preserves the literal pinned Redis/database/Meta/event order', async () => {
	const { pinnedResetEvents } = await import('../../helpers/pinned-test-controls.js');
	vi.stubEnv('NODE_ENV', 'test');
	const config = testConfig();
	vi.stubEnv('BACKEND_NEXT_TEST_RESET_TARGET', JSON.stringify({
		database: { host: config.database.host, port: config.database.port, database: config.database.database },
		redis: { host: config.redis.host, port: config.redis.port, db: config.redis.db ?? 0 },
	}));
	const events: string[] = [];
	const resources = {
		logger,
		redis: { flushdb: async () => {
			events.push('redis');
		} },
		dataSource: { manager: {}, transaction: async (run: (manager: unknown) => Promise<void>) => {
			events.push('database');
			await run({ query: async () => [] });
		} },
		meta: { fetch: async () => {
			events.push('meta');
			return {};
		} },
		publishInternalEvent: async () => {
			events.push('event');
		},
	};
	const response = await post(createTestControlsHttp(resources as never, config), 'reset-db', {});
	expect(response.status).toBe(204);
	expect(events).toEqual(await pinnedResetEvents('test'));
	await expect(pinnedResetEvents('production')).rejects.toThrow('NODE_ENV is not a test');
});
