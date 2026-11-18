/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiMeta, MiSystemAccount, MiUser, MiUserKeypair, MiUserProfile, MiUsedUsername } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createNoteChartStore } from '../../src/platform/database/chart/store.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { nodeInfoSource } from '../helpers/nodeinfo-source.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let base: string;
const meta = nodeInfoSource.observations[0].meta;
const address = (listener: Server) => `http://127.0.0.1:${(listener.address() as { port: number }).port}`;

beforeAll(async () => {
	database = await createTestDatabase();
	database.config.url = 'https://local.test:8443';
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('nodeinfo-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).save({ id: 'singleton', ...meta, federation: 'all' });
	const chartStore = createNoteChartStore(resources.dataSource, resources.redis);
	await chartStore.save({ series: 'notes', group: null, now: Date.now(), diff: {}, absolute: { 'local.total': 42, 'remote.total': 999 } });
	await chartStore.save({ series: 'users', group: null, now: Date.now(), diff: {}, absolute: { 'local.total': 7, 'remote.total': 999 } });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	base = address(server);
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

test('normal HTTP reads persisted hourly charts and fresh Meta, lazily creates proxy, and matches the pinned version sequence', async () => {
	expect(await resources.dataSource.getRepository(MiSystemAccount).countBy({ type: 'proxy' })).toBe(0);
	for (const observation of nodeInfoSource.observations.filter(o => o.scenario === '21-first')) {
		const response = await fetch(`${base}${observation.step.path}`, { method: observation.step.method ?? 'GET' });
		expect(response.status).toBe(observation.status);
		for (const [key, value] of Object.entries(observation.headers)) {
			if (response.status === 200 || key !== 'content-type') {
				expect(response.headers.get(key), key).toBe(value);
			}
		}
		if (observation.body !== null) {
			expect(await response.json()).toEqual(observation.body);
		} else if (observation.step.method === 'HEAD') {
			expect(await response.text()).toBe('');
		}
	}
	const proxy = await resources.dataSource.getRepository(MiSystemAccount).findOneByOrFail({ type: 'proxy' });
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: proxy.userId })).username).toBe('system.proxy');
	expect(await resources.dataSource.getRepository(MiUserProfile).existsBy({ userId: proxy.userId })).toBe(true);
	expect(await resources.dataSource.getRepository(MiUserKeypair).existsBy({ userId: proxy.userId })).toBe(true);
	expect(await resources.dataSource.getRepository(MiUsedUsername).existsBy({ username: 'system.proxy' })).toBe(true);
});

test('discovery reflects federation none immediately while document generation still succeeds and retains source defaults', async () => {
	const observation = nodeInfoSource.observations.find(o => o.scenario === 'federation-none')!;
	await resources.dataSource.getRepository(MiMeta).save({ id: 'singleton', ...observation.meta, federation: 'none' });
	await resources.meta.fetch(true);
	const freshServer = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	try {
		const url = address(freshServer);
		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			const discovery = await fetch(`${url}/.well-known/nodeinfo`, { method });
			expect(discovery.status).toBe(method === 'OPTIONS' ? 204 : 403);
			expect(discovery.headers.get('access-control-allow-origin')).toBe('*');
			expect(await discovery.text()).toBe('');
		}
		const document = await fetch(`${url}/nodeinfo/2.1`);
		expect(document.status).toBe(200);
		expect(await document.json()).toEqual(observation.body);
	} finally {
		await closeHttp(freshServer);
	}
});

test('2.0-first uses hub homepage for the shared cached 2.1 and discovers versions in source order', async () => {
	await resources.dataSource.getRepository(MiMeta).save({ id: 'singleton', ...meta, federation: 'all' });
	await resources.meta.fetch(true);
	const freshServer = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	try {
		const url = address(freshServer);
		const discovery = await fetch(`${url}/.well-known/nodeinfo`);
		expect(discovery.status).toBe(200);
		expect(discovery.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(discovery.headers.get('cache-control')).toBeNull();
		expect(await discovery.json()).toEqual({ links: ['2.1', '2.0'].map(version => ({ rel: `http://nodeinfo.diaspora.software/ns/schema/${version}`, href: `https://local.test:8443/nodeinfo/${version}` })) });
		for (const observation of nodeInfoSource.observations.filter(o => o.scenario === '20-first-expiry').slice(0, 2)) {
			const response = await fetch(`${url}${observation.step.path}`);
			expect(await response.json()).toEqual(observation.body);
		}
	} finally {
		await closeHttp(freshServer);
	}
});

for (const [table, stage] of [['__chart__notes', 'notes'], ['__chart__users', 'users'], ['meta', 'meta'], ['system_account', 'proxy']]) {
	test(`cold document returns uncached empty500 on persisted ${stage} read failure; warm document survives`, async () => {
		const cold = await connectResources(database.config, createLogger('nodeinfo-cold-test', () => {}));
		const coldServer = await listenHttp(createBackendHttpApp(cold, database.config), { port: 0 });
		await resources.dataSource.query(`ALTER TABLE "${table}" RENAME TO "nodeinfo_fault"`);
		try {
			try {
				expect((await fetch(`${base}/nodeinfo/2.1`)).status).toBe(200);
				const response = await fetch(`${address(coldServer)}/nodeinfo/2.1`);
				expect(response.status).toBe(500);
				expect(response.headers.get('cache-control')).toBeNull();
				expect(response.headers.get('access-control-allow-origin')).toBeNull();
				expect(await response.text()).toBe('');
				if (stage === 'meta') {
					const discovery = await fetch(`${address(coldServer)}/.well-known/nodeinfo`);
					expect(discovery.status).toBe(500);
					expect(discovery.headers.get('access-control-allow-origin')).toBe('*');
					expect(await discovery.text()).toBe('');
				}
				const preflight = await fetch(`${address(coldServer)}/.well-known/nodeinfo`, { method: 'OPTIONS' });
				expect(preflight.status).toBe(204);
			} finally {
				await resources.dataSource.query(`ALTER TABLE "nodeinfo_fault" RENAME TO "${table}"`);
			}
			expect((await fetch(`${address(coldServer)}/nodeinfo/2.1`)).status).toBe(200);
		} finally {
			await closeHttp(coldServer);
			await cold.close();
		}
	});
}
