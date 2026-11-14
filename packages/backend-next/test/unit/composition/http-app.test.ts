/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { createBackendHttpApp } from '../../../src/composition/http-app.js';
import { createBackendHttpApp as legacy } from '../../../src/composition/note-http.js';
import { testConfig } from '../../helpers/database.js';
import type { RuntimeResources } from '../../../src/composition/create-runtime.js';

function fixture() {
	const events: string[] = [];
	const repository = { find: vi.fn(async () => [{ federation: 'all' }]), findOne: vi.fn(async () => null), findOneBy: vi.fn(async () => null), findOneByOrFail: vi.fn(async () => ({ federation: 'all' })), findBy: vi.fn(async () => []) };
	const resources = {
		dataSource: { manager: { getRepository: () => repository } },
		logger: { error: vi.fn() },
		roleMaterials: { get changes() {
			events.push('role'); return {};
		} },
		actorInstanceRegistration: { start: () => {
			throw new Error('unexpected actor instance mutation');
		} },
		userHashtags: { start: () => {
			throw new Error('unexpected actor mutation');
		} },
		notePostSave: { start: vi.fn() },
		notePostDelete: { get start() {
			events.push('note'); return vi.fn();
		} },
	} as unknown as RuntimeResources;
	return { resources, events, repository };
}

test('composed app retains Role, Actor, Note, optional queue and unknown route behavior', async () => {
	const { resources, events } = fixture();
	const config = testConfig();
	const queue = new Hono().post('/api/test-queue', c => c.text('queue'));
	const app = createBackendHttpApp(resources, config, queue);
	expect(events).toEqual(['note', 'role']);
	expect(legacy).toBe(createBackendHttpApp);
	expect([...new Set(app.routes.map(route => route.path))]).toEqual([
		'/api/admin/roles/show', '/api/admin/roles/update', '/users/:id', '/:acct{@[^/]+}', '/users/:user/publickey', '/.well-known/webfinger',
		'/users/:id/collections/featured', '/notes/:id', '/users/:id/followers', '/users/:id/following',
		'/api/notes/delete', '/api/notes/show', '/api/notes/create', '/api/test-queue',
	]);
	for (const path of ['admin/roles/show', 'admin/roles/update', 'notes/delete', 'notes/create']) {
		const response = await app.request(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		expect(response.status).toBe(401);
		expect(await response.json()).toHaveProperty('error.code', 'CREDENTIAL_REQUIRED');
	}
	const show = await app.request('/api/notes/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	expect(show.status).toBe(400);
	expect(await show.json()).toHaveProperty('error.code', 'INVALID_PARAM');
	const actor = await app.request('/users/missing', { headers: { Accept: 'application/activity+json' } });
	expect(actor.status).toBe(404);
	expect(actor.headers.get('vary')).toBe('Accept');
	expect(await (await app.request('/api/test-queue', { method: 'POST' })).text()).toBe('queue');
	expect((await createBackendHttpApp(resources, config).request('/api/test-queue', { method: 'POST' })).status).toBe(404);
	expect((await app.request('/unknown')).status).toBe(404);
	const preflight = await app.request('/api/notes/show', { method: 'OPTIONS' });
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
	const invalid = await app.request('/api/notes/show', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid' }, body: '{}' });
	expect(invalid.status).toBe(401);
	expect(await invalid.json()).toHaveProperty('error.code', 'AUTHENTICATION_FAILED');
	expect(invalid.headers.get('www-authenticate')).toContain('Bearer');
});

test('Note preparation failure escapes unchanged before Role construction', () => {
	const { resources, events } = fixture();
	const failure = new Error('note preparation failed');
	Object.defineProperty(resources.notePostDelete, 'start', { get() {
		throw failure;
	} });
	expect(() => createBackendHttpApp(resources, testConfig())).toThrow(failure);
	expect(events).toEqual([]);
});

test('Role authentication infrastructure failure retains the base app error response', async () => {
	const { resources, repository } = fixture();
	repository.findOne.mockRejectedValueOnce(new Error('database unavailable'));
	const response = await createBackendHttpApp(resources, testConfig()).request('/api/admin/roles/show', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid' }, body: '{}',
	});
	expect(response.status).toBe(500);
	expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
	expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
});

test('ordinary composition exposes discovery CORS for an unknown local account', async () => {
	const { resources } = fixture();
	const response = await createBackendHttpApp(resources, testConfig()).request('/.well-known/webfinger?resource=acct:alice@example.test');
	expect(response.status).toBe(404);
	expect(response.headers.get('access-control-allow-headers')).toBe('Accept');
});

test.each(['GET', 'HEAD'])('ordinary composition passes its resource logger to discovery failures for %s', async method => {
	const { resources, repository } = fixture();
	repository.find.mockRejectedValueOnce(new Error('private Meta database diagnostic'));
	const response = await createBackendHttpApp(resources, testConfig()).request('/.well-known/webfinger?resource=alice', { method });
	expect(response.status).toBe(500);
	expect(await response.text()).toBe('');
	expect(response.headers.get('cache-control')).toBeNull();
	expect(response.headers.get('vary')).toBeNull();
	expect(response.headers.get('access-control-allow-origin')).toBe('*');
	expect(resources.logger.error).toHaveBeenCalledExactlyOnceWith('webfinger.failed', {
		classification: 'unexpected-failure', stage: 'meta-read',
	});
});

test.each(['followers', 'following'])('ordinary root exposes %s with federation gating and source OPTIONS fallback', async direction => {
	const { resources, repository } = fixture();
	repository.find.mockResolvedValue([{ federation: 'none' }]);
	const app = createBackendHttpApp(resources, testConfig());
	for (const method of ['GET', 'HEAD']) {
		const response = await app.request(`/users/missing/${direction}?cursor=a&cursor=b`, { method });
		expect(response.status).toBe(403);
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		expect(response.headers.get('cache-control')).toBeNull();
		expect(await response.text()).toBe('');
	}
	const options = await app.request(`/users/missing/${direction}`, { method: 'OPTIONS' });
	expect(options.status).toBe(404);
	expect(options.headers.get('content-type')).toBe('application/json; charset=utf-8');
	expect(options.headers.get('access-control-allow-origin')).toBeNull();
	expect(repository.findOne).not.toHaveBeenCalled();
});

test.each(['production', 'test'])('ordinary alias composition uses actual NODE_ENV=%s and stored redirect Meta', async mode => {
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = mode;
	try {
		const { resources, repository } = fixture();
		repository.find.mockResolvedValue([{ federation: 'all', allowExternalApRedirect: false }] as never);
		repository.findOneBy.mockResolvedValue({ id: 'remote', host: 'remote.test', uri: 'http://example.test/actor' } as never);
		const app = createBackendHttpApp(resources, testConfig());
		const response = await app.request('/@alice@remote.test', { headers: { Accept: 'application/activity+json' } });
		expect(response.status).toBe(mode === 'production' ? 406 : 301);
		repository.find.mockResolvedValue([{ federation: 'all', allowExternalApRedirect: true }] as never);
		const allowed = await app.request('/@alice@remote.test', { headers: { Accept: 'application/activity+json' } });
		expect(allowed.status).toBe(301);
		expect(allowed.headers.get('location')).toBe('http://example.test/actor');
	} finally {
		if (previous === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = previous;
		}
	}
});
