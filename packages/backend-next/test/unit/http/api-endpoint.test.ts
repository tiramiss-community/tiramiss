/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createApiEndpoints, type ApiEndpoint } from '../../../src/http/api-endpoint.js';
import { apiErrorResponse } from '../../../src/http/api-error.js';
import { AccessDenied, AuthenticationFailed, InputInvalid } from '../../../src/modules/access/public.js';
import type { AccessCredential, AccessRequest } from '../../../src/modules/access/public.js';

const moderator = { isSuspended: false, isModerator: true, isAdministrator: false };
const native: AccessCredential = { userId: 'user', native: true };

function setup(options: {
	handle?: ApiEndpoint['handle'];
	errors?: ApiEndpoint['errors'];
	authenticate?: (token: string | null | undefined) => Promise<{ credential: AccessCredential } | null>;
} = {}) {
	const tokens: (string | null | undefined)[] = [];
	const inputs: unknown[] = [];
	const logs: { event: string; fields?: Record<string, unknown> }[] = [];
	const app = createApiEndpoints({
		endpoints: [{
			name: 'test/op',
			access: { requireModerator: true, kind: 'read:test' },
			errors: options.errors,
			handle: options.handle ?? (async (access: AccessRequest, input: unknown) => {
				inputs.push(input);
				access.authorize(moderator);
				return { ok: true };
			}),
		}],
		authenticate: async token => {
			tokens.push(token);
			return options.authenticate ? options.authenticate(token) : token == null ? null : { credential: native };
		},
		logger: { info() {}, error: (event, fields) => logs.push({ event, fields }) },
	});
	const post = (body: string | undefined, headers: Record<string, string> = {}) => app.request('/api/test/op', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
	return { app, post, tokens, inputs, logs };
}

async function error(response: Response) {
	return { status: response.status, challenge: response.headers.get('WWW-Authenticate'), body: await response.json() };
}

describe('route guards', () => {
	test('a success carries CORS and private Cache-Control', async () => {
		const s = setup();
		const response = await s.post(JSON.stringify({ i: 'token' }), { Origin: 'https://client.test' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
	});

	test('a preflight is answered without authentication', async () => {
		const s = setup();
		const response = await s.app.request('/api/test/op', { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST' } });
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,POST');
		expect(s.tokens).toEqual([]);
	});

	test('GET is rejected with an empty 405 before authentication', async () => {
		const s = setup();
		const response = await s.app.request('/api/test/op?i=token');
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
		expect(s.tokens).toEqual([]);
	});

	test('a body over 1 MiB closes the connection with 413 before authentication', async () => {
		const s = setup();
		const response = await s.post(JSON.stringify({ i: 'token', pad: 'x'.repeat(1024 * 1024) }));
		expect(response.status).toBe(413);
		expect(response.headers.get('Connection')).toBe('close');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
		expect(s.tokens).toEqual([]);
	});

	test.each([['{', 'invalid JSON'], ['{"i":1}', 'a number token'], ['{"i":{}}', 'an object token']])('%s (%s) gives an empty 400', async body => {
		const s = setup();
		const response = await s.post(body);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('');
		expect(s.tokens).toEqual([]);
	});

	test('guards apply only to the registered endpoint paths', async () => {
		const root = new Hono().get('/users/alice', context => context.text('actor'));
		root.route('/', setup().app);
		const response = await root.request('/users/alice', { headers: { Origin: 'https://client.test' } });
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.headers.get('Cache-Control')).toBeNull();
	});
});

describe('token and authentication', () => {
	test('a case-sensitive Bearer header wins over i, which stays in the input', async () => {
		const s = setup();
		await s.post(JSON.stringify({ i: 'body-token', a: 1 }), { Authorization: 'Bearer header-token' });
		await s.post(JSON.stringify({ i: 'body-token' }), { Authorization: 'bearer header-token' });
		expect(s.tokens).toEqual(['header-token', 'body-token']);
		expect(s.inputs[0]).toEqual({ i: 'body-token', a: 1 });
	});

	test('a guest is rejected with a plain challenge before the handler runs', async () => {
		let called = false;
		const s = setup({ handle: async () => {
			called = true;
		} });
		expect(await error(await s.post('{}'))).toEqual({
			status: 401, challenge: 'Bearer realm="Misskey"',
			body: { error: { message: 'Credential required.', code: 'CREDENTIAL_REQUIRED', id: '1384574d-a912-4b81-8601-c7b1c4085df1', kind: 'client' } },
		});
		expect(called).toBe(false);
	});

	test('an authentication failure gives 401 invalid_token', async () => {
		const s = setup({ authenticate: async () => {
			throw new AuthenticationFailed();
		} });
		expect(await error(await s.post('{"i":"bad"}'))).toEqual({
			status: 401,
			challenge: 'Bearer realm="Misskey", error="invalid_token", error_description="Authentication failed. Please ensure your token is correct."',
			body: { error: { message: 'Authentication failed. Please ensure your token is correct.', code: 'AUTHENTICATION_FAILED', id: 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14', kind: 'client' } },
		});
	});

	test('an unexpected authentication-stage failure is a bare INTERNAL_ERROR and is logged', async () => {
		const s = setup({ authenticate: async () => {
			throw new Error('database lost');
		} });
		expect(await error(await s.post('{"i":"token"}'))).toEqual({
			status: 500, challenge: null,
			body: { error: { message: 'Internal error occurred. Please contact us if the error persists.', code: 'INTERNAL_ERROR', id: '5d37dbcb-891e-41ca-a3d6-e690c97775ac', kind: 'server' } },
		});
		expect(s.logs.map(log => log.event)).toEqual(['api.authentication-failed']);
	});
});

describe('endpoints without a credential requirement', () => {
	function optional(kind?: string) {
		const seen: (AccessCredential | null)[] = [];
		const app = createApiEndpoints({
			endpoints: [{ name: 'test/open', access: kind ? { kind } : {}, handle: async access => {
				seen.push(access.credential);
				return { ok: true };
			} }],
			authenticate: async token => token == null ? null : { credential: { userId: 'user', native: false, permissions: new Set<string>() } },
			logger: { info() {}, error() {} },
		});
		const post = (body: string) => app.request('/api/test/open', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
		return { post, seen };
	}

	test('a guest reaches the handler without facts', async () => {
		const s = optional();
		expect((await s.post('{}')).status).toBe(200);
		expect(s.seen).toEqual([null]);
	});

	test('a token without the endpoint kind is rejected before the handler', async () => {
		const s = optional('read:account');
		expect((await error(await s.post('{"i":"token"}'))).body.error.code).toBe('PERMISSION_DENIED');
		expect((await s.post('{}')).status).toBe(200);
		expect(s.seen).toEqual([null]);
	});
});

describe('handler results and errors', () => {
	test('an undefined result is an empty 204', async () => {
		const s = setup({ handle: async access => {
			access.authorize(moderator);
		} });
		const response = await s.post('{"i":"token"}');
		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	});

	test('an unexpected handler failure carries info.e and is logged with the same id', async () => {
		const s = setup({ handle: async () => {
			throw new TypeError('broken');
		} });
		const { status, challenge, body } = await error(await s.post('{"i":"token"}'));
		expect({ status, challenge }).toEqual({ status: 500, challenge: null });
		expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR', kind: 'server', info: { e: { message: 'broken', code: 'TypeError' } } });
		expect(s.logs).toEqual([{ event: 'api.failed', fields: { endpoint: 'test/op', errorId: body.error.info.e.id, error: expect.any(TypeError) } }]);
	});

	test('a handler that never authorizes cannot succeed', async () => {
		const s = setup({ handle: async () => ({ leaked: true }) });
		const { status, body } = await error(await s.post('{"i":"token"}'));
		expect(status).toBe(500);
		expect(body.error.info.e.message).toBe('Endpoint test/op completed without authorization');
	});

	test('endpoint errors are mapped before common errors', async () => {
		const s = setup({
			handle: async () => {
				throw new RangeError('missing');
			},
			errors: error => error instanceof RangeError ? { message: 'No such thing.', code: 'NO_SUCH_THING', id: 'x' } : undefined,
		});
		expect(await error(await s.post('{"i":"token"}'))).toEqual({
			status: 400, challenge: 'Bearer realm="Misskey", error="invalid_request", error_description="No such thing."',
			body: { error: { message: 'No such thing.', code: 'NO_SUCH_THING', id: 'x', kind: 'client' } },
		});
	});

	test.each([
		[new AccessDenied('YOUR_ACCOUNT_SUSPENDED'), 403, null, 'YOUR_ACCOUNT_SUSPENDED'],
		[new AccessDenied('MODERATOR_REQUIRED'), 403, null, 'ROLE_PERMISSION_DENIED'],
		[new AccessDenied('PERMISSION_DENIED'), 403, 'Bearer realm="Misskey", error="insufficient_scope", error_description="Your app does not have the necessary permissions to use this endpoint."', 'PERMISSION_DENIED'],
		[new InputInvalid('#/required', 'must have required property \'x\''), 400, 'Bearer realm="Misskey", error="invalid_request", error_description="Invalid param."', 'INVALID_PARAM'],
	])('maps %s to the upstream status and challenge', async (thrown, status, challenge, code) => {
		const s = setup({ handle: async () => {
			throw thrown;
		} });
		const result = await error(await s.post('{"i":"token"}'));
		expect({ status: result.status, challenge: result.challenge, code: result.body.error.code }).toEqual({ status, challenge, code });
	});
});

describe('apiErrorResponse', () => {
	test('a rate limit adds Retry-After only', async () => {
		const response = apiErrorResponse({ message: 'Rate limit exceeded. Please try again later.', code: 'RATE_LIMIT_EXCEEDED', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef', status: 429, info: { resetMs: 10_500 } }, 1_000);
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('10');
		expect(response.headers.get('WWW-Authenticate')).toBeNull();
	});

	test('a 401 other than an authentication failure gets the plain realm', () => {
		expect(apiErrorResponse({ message: 'Credential required.', code: 'CREDENTIAL_REQUIRED', id: 'id', status: 401 }).headers.get('WWW-Authenticate')).toBe('Bearer realm="Misskey"');
	});

	test('a permission error other than PERMISSION_DENIED has no challenge', () => {
		const response = apiErrorResponse({ message: 'm', code: 'ROLE_PERMISSION_DENIED', id: 'id', kind: 'permission' });
		expect(response.status).toBe(403);
		expect(response.headers.get('WWW-Authenticate')).toBeNull();
	});
});
