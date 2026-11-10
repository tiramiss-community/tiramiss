/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiInstance, MiMeta, MiUser, MiUserProfile, MiUserKeypair } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { createDeliverJobHandler } from '../../src/composition/deliver-job.js';
import { createInstanceMetadata } from '../../src/platform/instance-metadata.js';
import { createInstanceLedger } from '../../src/platform/instance-ledger.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { plainActor, deferred } from '../helpers/remote-peer.js';
import { startMetadataPeer, metadataReply, expectedMetadata } from '../helpers/instance-metadata-peer.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let peer: Awaited<ReturnType<typeof startMetadataPeer>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let app: ReturnType<typeof createBackendHttpApp>;
let port: number;
let author: string;
const codec = createIdCodec('aidx');
const token = 'metadata243test1';
const logs: string[] = [];
const lockKey = 'fetchInstanceMetadata:mutex:v2:remote.test';
beforeAll(async () => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	peer = await startMetadataPeer(); database.config.url = 'http://local.test'; database.config.outboundHttp.proxy = peer.proxy;
});
beforeEach(async () => {
	peer.requests.length = 0; peer.respond(async path => metadataReply(path));
	resources = await connectResources(database.config, createLogger('metadata-test', line => logs.push(line)));
	await resources.redis.del(lockKey, 'kvcache:federatedInstance:remote.test');
	await resources.dataSource.getRepository(MiInstance).delete({ host: 'remote.test' });
	await resources.dataSource.getRepository(MiMeta).upsert({ id: 'singleton', federation: 'all', enableStatsForFederatedInstances: true }, ['id']);
	author = codec.newId(Date.now());
	const pair = await generateRsaKeyPair();
	await resources.dataSource.getRepository(MiUser).update({ token }, { token: null });
	await resources.dataSource.getRepository(MiUser).insert({ id: author, username: author, usernameLower: author, token });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: author });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: author, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	app = createBackendHttpApp(resources, database.config); server = await listenHttp(app, { port: 0 }); port = (server.address() as { port: number }).port;
	peer.actor.route('local.test', port); peer.actor.clearKeys();
	peer.actor.respond(async req => {
		const url = new URL(req.path, peer.actor.origin);
		if (req.method === 'POST') {
			return { body: {} };
		}
		if (url.pathname === '/.well-known/webfinger') {
			const name = url.searchParams.get('resource')!.slice(5).split('@')[0];
			return { body: { links: [{ rel: 'self', href: `${peer.actor.origin}/users/${name.startsWith('alias_') ? name.slice(6) : name}` }] } };
		}
		return { body: plainActor(peer.actor.origin, url.pathname.split('/').at(-1)!) };
	});
});
afterEach(async () => {
	if (server) {
		await closeHttp(server);
	} await resources?.close();
});
afterAll(async () => {
	await peer?.close(); await database?.close(); vi.unstubAllEnvs();
});

async function post(name: string) {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, text: `@${name}@remote.test`, localOnly: true }) });
	expect(response.status, await response.clone().text()).toBe(200); return response.json();
}

function acquisition(clock = Date.now) {
	const ledger = createInstanceLedger({ manager: resources.dataSource.manager, redis: resources.redis, newId: codec.newId, clock });
	const failures: unknown[] = [];
	const fetch = createInstanceMetadata({ ledger, redis: resources.redis, http: resources.outboundHttp, clock, reportFailure: error => failures.push(error) });
	return { ledger, fetch, failures };
}

test('public actor create and canonical duplicate both acquire actual HTTPS fields independently of increment rejection', async () => {
	const name = `metadata_${author}`;
	await post(name); await resources.actorInstanceRegistration.idle();
	expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ host: 'remote.test' })).toMatchObject({ ...expectedMetadata, usersCount: 1 });
	// Replace caller composition to get a cold source-compatible ledger, just as a new HTTP process would.
	await resources.close(); resources = await connectResources(database.config, createLogger('metadata-test', line => logs.push(line)));
	await resources.dataSource.getRepository(MiInstance).update({ host: 'remote.test' }, { infoUpdatedAt: null, name: null });
	await resources.redis.del('kvcache:federatedInstance:remote.test');
	await resources.dataSource.query("CREATE FUNCTION metadata_increment_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.\"usersCount\" <> OLD.\"usersCount\" THEN RAISE EXCEPTION 'increment rejected'; END IF; RETURN NEW; END $$");
	await resources.dataSource.query('CREATE TRIGGER metadata_increment_fail BEFORE UPDATE ON instance FOR EACH ROW EXECUTE FUNCTION metadata_increment_fail()');
	await closeHttp(server); app = createBackendHttpApp(resources, database.config); server = await listenHttp(app, { port: 0 }); port = (server.address() as { port: number }).port; peer.actor.route('local.test', port);
	try {
		await post('alias_' + name); await resources.actorInstanceRegistration.idle();
		expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: name, host: 'remote.test' })).toBe(1);
		expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ host: 'remote.test' })).toMatchObject({ ...expectedMetadata, usersCount: 1 });
		expect(logs.some(line => line.includes('actor-instance-registration.failed') && line.includes('increment'))).toBe(true);
		const actor = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ usernameLower: name, host: 'remote.test' });
		const shown = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: token, text: 'remote', localOnly: true }) });
		expect(shown.status).toBe(200);
		const { readNoteAuthors } = await import('../../src/platform/database/note-authors.js');
		const meta = await resources.dataSource.getRepository(MiMeta).findOneByOrFail({ id: 'singleton' });
		const authors = await readNoteAuthors(resources.dataSource.manager, [actor.id], null, meta, { url: database.config.url, createdAtFromId: codec.createdAtFromId }, Date.now(), new Map());
		expect(authors.get(actor.id)?.view.instance).toMatchObject({ name: 'Real HTTPS peer', softwareName: 'misskey', iconUrl: 'https://remote.test/manifest.png' });
	} finally {
		await resources.dataSource.query('DROP TRIGGER metadata_increment_fail ON instance'); await resources.dataSource.query('DROP FUNCTION metadata_increment_fail()');
	}
	expect(peer.requests).toContainEqual({ method: 'GET', path: '/', accept: 'text/html, */*' });
});

test('stats-disabled public actor and failed delivery do not start metadata; successful delivery starts and drains real acquisition', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: false });
	await post(`disabled_${author}`); await resources.actorInstanceRegistration.idle(); expect(peer.requests).toEqual([]);
	const handler = createDeliverJobHandler(resources, database.config);
	const job = { user: { id: author }, content: '{}', digest: '', to: 'http://remote.test/inbox', isSharedInbox: true };
	await handler.process(job); await handler.idle(); expect(peer.requests).toEqual([]);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
	peer.actor.respond(async () => ({ status: 503 }));
	expect((await handler.process(job)).kind).toBe('retry'); await handler.idle(); expect(peer.requests).toEqual([]);
	peer.actor.respond(async req => req.method === 'POST' ? { body: {} } : { status: 404 });
	await resources.dataSource.query("CREATE FUNCTION metadata_responding_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.\"isNotResponding\" AND NOT NEW.\"isNotResponding\" THEN RAISE EXCEPTION 'responding rejected'; END IF; RETURN NEW; END $$");
	await resources.dataSource.query('CREATE TRIGGER metadata_responding_fail BEFORE UPDATE ON instance FOR EACH ROW EXECUTE FUNCTION metadata_responding_fail()');
	const entered = deferred(); const release = deferred();
	peer.respond(async path => {
		if (path === '/') {
			entered.resolve(); await release.promise;
		} return metadataReply(path);
	});
	try {
		expect(await handler.process(job)).toEqual({ kind: 'done', result: 'Success' }); await entered.promise;
		let done = false; const idle = handler.idle().then(() => {
			done = true;
		});
		await Promise.resolve(); expect(done).toBe(false); release.resolve(); await idle;
		expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ host: 'remote.test' })).toMatchObject({ ...expectedMetadata, isNotResponding: true });
	} finally {
		release.resolve(); await handler.idle(); await resources.dataSource.query('DROP TRIGGER metadata_responding_fail ON instance'); await resources.dataSource.query('DROP FUNCTION metadata_responding_fail()');
	}
});

test('real Redis contender renews TTL without unlock; force deletes existing lock and update replaces whole-row cache', async () => {
	const { ledger, fetch } = acquisition(); const instance = await ledger.fetchOrRegisterInstance('remote.test');
	await resources.redis.set(lockKey, '1', 'EX', 2); await fetch(instance);
	expect(await resources.redis.ttl(lockKey)).toBeGreaterThanOrEqual(29); expect(peer.requests).toEqual([]);
	await fetch(instance, true); expect(await resources.redis.exists(lockKey)).toBe(0);
	const cached = JSON.parse((await resources.redis.get('kvcache:federatedInstance:remote.test'))!);
	expect(cached).toMatchObject(expectedMetadata); expect((await ledger.fetchOrRegisterInstance('remote.test')).infoUpdatedAtMs).toBeGreaterThan(0);
});

test('warm process caches preserve freshness independently; exact 24h and completion clock are explicit', async () => {
	let now = 1800000000000;
	const a = acquisition(() => now); const instance = await a.ledger.fetchOrRegisterInstance('remote.test');
	await a.ledger.updateInstance(instance.id, { infoUpdatedAtMs: now });
	const b = acquisition(() => now); await b.ledger.fetchOrRegisterInstance('remote.test');
	await a.ledger.updateInstance(instance.id, { infoUpdatedAtMs: now - 86400000 });
	await b.fetch(instance); expect(peer.requests).toEqual([]);
	now += 180001; await b.fetch(instance);
	expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ id: instance.id })).toMatchObject(expectedMetadata);
	const count = peer.requests.length; now += 86399999; await b.fetch(instance); expect(peer.requests).toHaveLength(count);
	now += 1; await b.fetch(instance); expect(peer.requests.length).toBeGreaterThan(count);
});

test('all real remote fetch failures still persist timestamp while oversized source values reject atomically', async () => {
	const { ledger, fetch, failures } = acquisition(() => 1800000000000); const instance = await ledger.fetchOrRegisterInstance('remote.test');
	peer.respond(async () => ({ status: 503 })); await fetch(instance);
	expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ id: instance.id })).toMatchObject({ name: null, infoUpdatedAt: new Date(1800000000000) });
	peer.respond(async path => path === '/nodeinfo/2.1' ? { body: { metadata: { nodeName: 'X'.repeat(257) } } } : metadataReply(path));
	await fetch(instance, true); expect(failures).toHaveLength(1);
	expect((await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ id: instance.id })).name).toBeNull(); expect(await resources.redis.exists(lockKey)).toBe(0);
});

test('expired owner and forced operation preserve source unconditional unlock race', async () => {
	const { ledger, fetch } = acquisition(); const instance = await ledger.fetchOrRegisterInstance('remote.test');
	const entered = deferred(); const release = deferred();
	peer.respond(async path => {
		if (path === '/') {
			entered.resolve(); await release.promise;
		} return metadataReply(path);
	});
	const running = fetch(instance); await entered.promise;
	try {
		await resources.redis.pexpire(lockKey, 1); await vi.waitFor(async () => expect(await resources.redis.exists(lockKey)).toBe(0));
		await resources.redis.set(lockKey, 'replacement', 'EX', 30);
	} finally {
		release.resolve(); await running;
	}
	expect(await resources.redis.exists(lockKey)).toBe(0);
});

test('successful persistence survives unlock rejection and the caller can diagnose the escaping failure', async () => {
	const { ledger, fetch } = acquisition();
	const instance = await ledger.fetchOrRegisterInstance('remote.test');
	const realDel = resources.redis.del.bind(resources.redis);
	const failure = vi.spyOn(resources.redis, 'del').mockImplementation(((...args: string[]) => {
		if (args[0] === lockKey) {
			return Promise.reject(Error('unlock rejected'));
		}
		return realDel(...args);
	}) as typeof resources.redis.del);
	try {
		await expect(fetch(instance)).rejects.toThrow('unlock rejected');
		expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ id: instance.id })).toMatchObject(expectedMetadata);
	} finally {
		failure.mockRestore(); await realDel(lockKey);
	}
});

test('source undefined fields preserve prior columns while explicit null maintainer replaces values and getHtml honors Accept override', async () => {
	const { ledger, fetch } = acquisition();
	const instance = await ledger.fetchOrRegisterInstance('remote.test');
	await fetch(instance);
	peer.respond(async path => path === '/nodeinfo/2.1' ? { body: { software: { name: 'OTHER' } } } : metadataReply(path));
	await fetch(instance, true);
	expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ id: instance.id })).toMatchObject({ softwareName: 'other', softwareVersion: '2026.1', openRegistrations: true, maintainerName: null, maintainerEmail: null });
	expect(await resources.outboundHttp.getHtml('https://remote.test', undefined, { Accept: 'custom/html' })).toContain('HTML name');
	expect(peer.requests.at(-1)).toEqual({ method: 'GET', path: '/', accept: 'custom/html' });
});
