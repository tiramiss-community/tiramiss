/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import observations from '../../../../../docs/superpowers/compatibility/api-ip-log/observations.json' with { type: 'json' };
import { defaultTrustedProxies, apiIpLogging } from '../../../src/http/api-ip-log.js';
import { createApiEndpoints } from '../../../src/http/api-endpoint.js';
import { AuthenticationFailed, InputInvalid } from '../../../src/modules/access/public.js';

const logger = { info() {}, error() {} };

function setup(trustProxy: boolean | number | string | string[] | undefined = undefined, failure = false) {
	const rows: unknown[] = [];
	const app = new Hono().use('/api/*', apiIpLogging((userId, ip) => rows.push({ userId, ip }), trustProxy)).route('/', createApiEndpoints({
		logger,
		authenticate: async token => {
			if (token === 'bad') {
				throw new AuthenticationFailed();
			}
			return token ? { credential: { userId: token, native: true } } : null;
		},
		endpoints: [{ name: 'test', access: { requireCredential: false }, handle: async access => {
			if (access.credential) {
				access.authorize({ isSuspended: false, isModerator: false, isAdministrator: false });
			}
			if (failure) {
				throw new InputInvalid('body', 'bad');
			}
			return { ok: true };
		} }],
	}));
	const post = (token: string | null, remoteAddress = '127.0.0.1', forwarded = '203.0.113.7, 10.0.0.1') => app.request('/api/test', { method: 'POST', body: JSON.stringify({ i: token }) }, { incoming: { socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } } });
	return { rows, post };
}

test('logs successful authentication even if the business rejects; skips anonymous and failed authentication', async () => {
	const s = setup(undefined, true);
	expect((await s.post(null)).status).toBe(400);
	expect((await s.post('bad')).status).toBe(401);
	expect(s.rows).toEqual([]);
	expect((await s.post('alice')).status).toBe(400);
	expect(s.rows).toEqual([{ userId: 'alice', ip: '203.0.113.7' }]);
});

test.each([
	[undefined, '127.0.0.1', '203.0.113.7'],
	[undefined, '198.51.100.2', '198.51.100.2'],
	[false, '127.0.0.1', '127.0.0.1'],
	[true, '198.51.100.2', '203.0.113.7'],
	[1, '127.0.0.1', '10.0.0.1'],
	[['loopback'], '::ffff:127.0.0.1', '10.0.0.1'],
] as const)('resolves trusted hops for %j and peer %s', async (trust, peer, expected) => {
	const s = setup(Array.isArray(trust) ? [...trust] : trust as boolean | number | undefined);
	expect((await s.post('alice', peer)).status).toBe(200);
	expect(s.rows).toEqual([{ userId: 'alice', ip: expected }]);
});

test('a failing observer cannot replace the successful API result', async () => {
	const app = new Hono().use('*', async (context, next) => {
		context.set('recordApiIp', () => {
			throw Error('address');
		});
		await next();
	}).route('/', createApiEndpoints({ logger, authenticate: async () => ({ credential: { userId: 'alice', native: true } }), endpoints: [{ name: 'test', access: { requireCredential: false }, handle: async access => {
		access.authorize({ isSuspended: false, isModerator: false, isAdministrator: false });
		return { ok: true };
	} }] }));
	expect(await (await app.request('/api/test', { method: 'POST', body: '{}' })).json()).toEqual({ ok: true });
});

test('uses pinned upstream trusted-proxy defaults', () => {
	expect(defaultTrustedProxies).toEqual(observations.trustedProxies);
});

test('accepts Fastify comma-separated trusted proxy settings', async () => {
	const s = setup('loopback, 10.0.0.0/8');
	expect((await s.post('alice')).status).toBe(200);
	expect(s.rows).toEqual([{ userId: 'alice', ip: '203.0.113.7' }]);
});
