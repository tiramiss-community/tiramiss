/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiInstance, MiMeta, MiUser, MiUserProfile, MiUserKeypair } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createTestDatabase } from '../helpers/database.js';
import { plainActor, deferred } from '../helpers/remote-peer.js';
import { startMetadataPeer, metadataReply, expectedMetadata } from '../helpers/instance-metadata-peer.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let redis: Redis;
let peer: Awaited<ReturnType<typeof startMetadataPeer>>;
let author: string;
const token = 'metadataproc2431';
const codec = createIdCodec('aidx');
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	redis = new Redis(database.config.redis);
	peer = await startMetadataPeer(); database.config.url = 'http://local.test'; database.config.outboundHttp.proxy = peer.proxy;
	database.config.processes.shutdownTimeoutMs = 10000;
	author = codec.newId(Date.now()); const pair = await generateRsaKeyPair();
	await source.getRepository(MiUser).insert({ id: author, username: 'author', usernameLower: 'author', token });
	await source.getRepository(MiUserProfile).insert({ userId: author });
	await source.getRepository(MiUserKeypair).insert({ userId: author, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	await source.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all', enableStatsForFederatedInstances: true });
	peer.actor.respond(async req => {
		const url = new URL(req.path, peer.actor.origin);
		if (req.method === 'POST') {
			return { body: {} };
		}
		if (url.pathname === '/.well-known/webfinger') {
			return { body: { links: [{ rel: 'self', href: `${peer.actor.origin}/users/metadata_process` }] } };
		}
		return { body: plainActor(peer.actor.origin, 'metadata_process') };
	});
});
afterAll(async () => {
	await peer?.close(); if (redis) {
		await redis.quit();
	} await source?.destroy(); await database?.close();
});

async function refuses(port: number) {
	return new Promise<boolean>(resolve => {
		const socket = connect(port, '127.0.0.1');
		socket.on('connect', () => {
			socket.destroy(); resolve(false);
		}); socket.on('error', () => resolve(true));
	});
}

test.each(['http', 'worker'])('built %s completes its originating operation while metadata is held, then SIGTERM drains before releasing dependencies', async kind => {
	await source.getRepository(MiInstance).delete({ host: 'remote.test' });
	await redis.del('fetchInstanceMetadata:mutex:v2:remote.test', 'kvcache:federatedInstance:remote.test');
	peer.requests.length = 0;
	const entered = deferred(); const release = deferred();
	peer.respond(async path => {
		if (path === '/') {
			entered.resolve(); await release.promise;
		} return metadataReply(path);
	});
	const port = await freePort(); database.config.http.port = port; peer.actor.route('local.test', port);
	const config = await configuration(database.config);
	const env = { MISSKEY_WEBFINGER_USE_HTTP: 'true', NODE_EXTRA_CA_CERTS: peer.certPath };
	const http = launch('built/entrypoints/http.js', config.path, env);
	const worker = kind === 'worker' ? launch('built/entrypoints/worker.js', config.path, env) : null;
	const queue = kind === 'worker' ? new Queue('deliver', baseQueueOptions(database.config.redisForJobQueue, 'deliver', 10000)) : null;
	const target = worker ?? http;
	let exitObserved = false;
	void target.exit.then(() => {
		exitObserved = true;
	});
	try {
		await http.ready; if (worker) {
			await worker.ready;
		}
		if (queue) {
			const job = await queue.add('deliver', { user: { id: author }, content: '{}', digest: `SHA-256=${createHash('sha256').update('{}').digest('base64')}`, to: 'http://remote.test/inbox', isSharedInbox: true });
			await entered.promise;
			await vi.waitFor(async () => expect(await job.getState()).toBe('completed'), { timeout: 5000 });
			expect(peer.actor.requests.some(req => req.method === 'POST' && req.signature === true && req.digest === true)).toBe(true);
		} else {
			const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, text: '@metadata_process@remote.test', localOnly: true }) });
			expect(response.status, await response.clone().text()).toBe(200); await entered.promise;
		}
		expect(peer.requests).toContainEqual({ method: 'GET', path: '/', accept: 'text/html, */*' });
		expect((await source.getRepository(MiInstance).findOneByOrFail({ host: 'remote.test' })).name).toBeNull();
		target.child.kill('SIGTERM');
		if (kind === 'http') {
			await vi.waitFor(async () => expect(await refuses(port)).toBe(true), { timeout: 3000 });
		} else {
			await vi.waitFor(async () => expect(await queue!.getWorkers()).toHaveLength(0), { timeout: 3000 });
		}
		expect(exitObserved).toBe(false);
		release.resolve(); expect(await target.exit, target.output()).toEqual({ code: 0, signal: null });
		expect(await source.getRepository(MiInstance).findOneByOrFail({ host: 'remote.test' })).toMatchObject(expectedMetadata);
		expect(target.output()).not.toContain('instance-metadata.failed');
		if (worker) {
			http.child.kill('SIGTERM'); expect(await http.exit, http.output()).toEqual({ code: 0, signal: null });
		}
	} finally {
		release.resolve(); await target.close(); if (worker) {
			await http.close();
		} await queue?.close(); await config.close();
	}
});
