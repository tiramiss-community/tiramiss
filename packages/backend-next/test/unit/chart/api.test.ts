/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createNoteChartsApi, createUsersChartsApi } from '../../../src/http/note-charts-api.js';
import { AuthenticationFailed } from '../../../src/modules/access/public.js';
import { createLogger } from '../../../src/platform/logger.js';

const logger = createLogger('chart-api-test', () => {});

function setup() {
	const read = vi.fn().mockResolvedValue({ total: [10] });
	const authenticate = vi.fn().mockResolvedValue(null);
	return { read, authenticate, app: createNoteChartsApi({ read }, { logger, authenticate }) };
}

test.each([
	['/api/charts/notes?span=hour', 'notes', 'hour', 30, null, null],
	['/api/charts/notes?span=day&limit=500&offset=0', 'notes', 'day', 500, 0, null],
	['/api/charts/user/notes?span=day&limit=1&offset=null&userId=alice', 'perUserNotes', 'day', 1, null, 'alice'],
] as const)('anonymous GET parameters and cache %s', async (path, ...args) => {
	const { app, read } = setup();
	const result = await app.request(path);
	expect(result.status).toBe(200);
	expect(result.headers.get('Cache-Control')).toBe('public, max-age=3600');
	expect(read).toHaveBeenCalledWith(...args);
});

test.each([
	'?span=minute', '?span=day&limit=0', '?span=hour&limit=501', '?span=hour&limit=1.5', '?span=hour&offset=1.5', '?span=hour&limit=1&limit=2', '?span=hour&offset=bad', '?span=hour&limit=01', '?span=hour&limit=true', '?span=hour&offset=%22foo%22', '',
])('rejects invalid input %s', async query => {
	const { app, read } = setup();
	const result = await app.request('/api/charts/notes' + query);
	expect(result.status).toBe(400);
	expect(await result.json()).toMatchObject({ error: { code: 'INVALID_PARAM' } });
	expect(read).not.toHaveBeenCalled();
});

test('POST does not coerce numeric strings and never advertises public caching', async () => {
	const { app } = setup();
	const call = (input: unknown) => app.request('/api/charts/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
	expect((await call({ span: 'hour', limit: '1' })).status).toBe(400);
	const result = await call({ span: 'hour', limit: 1 });
	expect(result.status).toBe(200);
	expect(result.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
});

test('unknown user is not looked up, missing userId is invalid, and invalid credentials fail', async () => {
	const { app, authenticate } = setup();
	expect((await app.request('/api/charts/user/notes?span=hour')).status).toBe(400);
	expect((await app.request('/api/charts/user/notes?span=hour&userId=missing')).status).toBe(200);
	authenticate.mockRejectedValueOnce(new AuthenticationFailed());
	const result = await app.request('/api/charts/notes?span=hour&i=bad');
	expect(result.status).toBe(401);
	expect(await result.json()).toMatchObject({ error: { code: 'AUTHENTICATION_FAILED' } });
});

test('malformed GET numbers use the pinned casting error rather than Ajv validation', async () => {
	const { app } = setup();
	const response = await app.request('/api/charts/notes?span=hour&limit=01');
	expect(await response.json()).toMatchObject({ error: { id: '0b5f1631-7c1a-41a6-b399-cce335f34d85', info: { param: 'limit', reason: 'cannot cast to integer' } } });
});

test('users chart exposes GET/POST with shared parameter, credential and cache rules', async () => {
	const read = vi.fn().mockResolvedValue({ local: { total: [1] }, remote: { total: [2] } });
	const authenticate = vi.fn().mockResolvedValue(null);
	const app = createUsersChartsApi({ read }, { logger, authenticate });
	const response = await app.request('/api/charts/users?span=day&limit=2&offset=123');
	expect(response.status).toBe(200);
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
	expect(read).toHaveBeenCalledWith('users', 'day', 2, 123, null);
	const epoch = await app.request('/api/charts/users?span=hour&offset=0');
	expect(epoch.status).toBe(200);
	expect(read).toHaveBeenCalledWith('users', 'hour', 30, 0, null);
	const optional = await app.request('/api/charts/users?span=hour&i=valid');
	expect(optional.status).toBe(200);
	expect(optional.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
	expect((await app.request('/api/charts/users?span=bad')).status).toBe(400);
	const posted = await app.request('/api/charts/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ span: 'hour' }) });
	expect(posted.status).toBe(200);
	expect(posted.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
	authenticate.mockRejectedValueOnce(new AuthenticationFailed());
	expect((await app.request('/api/charts/users?span=hour&i=bad')).status).toBe(401);
});
