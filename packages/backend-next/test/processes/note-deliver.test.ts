/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiChannel, MiFollowing, MiMeta, MiNote, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { startInboxRecorder } from '../helpers/outbound-http-fakes.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../../src/config/types.js';
import type { InboxRecorder } from '../helpers/outbound-http-fakes.js';

const observations = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8')) as Record<string, unknown>;

// 本家の観測で fake inbox が待ち受けたアドレス。観測の本文はこの値のまま記録されている。
const observedInbox = 'http://127.0.0.1:63167';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let inbox: InboxRecorder;
let publicKeyPem: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seeded = await seedRoleHttp(source);
	inbox = await startInboxRecorder();
	const { codec } = seeded;

	const alice = seeded.actors.ordinary.id;
	const bob = seeded.actors.moderator.id;
	ids.alice = alice;
	const pair = await generateRsaKeyPair();
	publicKeyPem = pair.publicKeyPem;
	await source.getRepository(MiUserKeypair).insert({ userId: alice, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	await source.getRepository(MiUserProfile).insert([{ userId: alice, userHost: null }, { userId: bob, userHost: null }]);
	await source.getRepository(MiMeta).update({ id: 'singleton' }, { federation: 'all' });

	// 本家の観測と同じく、remote1・remote2 は同じ shared inbox を持ち、alice をフォローする。
	const host = new URL(inbox.origin).host;
	for (const name of ['remote1', 'remote2']) {
		const id = codec.newId(Date.now());
		ids[name] = id;
		await source.getRepository(MiUser).insert({
			id, username: name, usernameLower: name, host, uri: `${inbox.origin}/users/${name}`, inbox: `${inbox.origin}/inbox/${name}`, sharedInbox: `${inbox.origin}/inbox/shared`,
		});
		await source.getRepository(MiFollowing).insert({
			id: codec.newId(Date.now()), followerId: id, followeeId: alice, followerHost: host, followerInbox: `${inbox.origin}/inbox/${name}`, followerSharedInbox: `${inbox.origin}/inbox/shared`,
		});
	}
	ids['remote-base'] = codec.newId(Date.now());
	await source.getRepository(MiNote).insert({ id: ids['remote-base'], userId: ids.remote1, userHost: host, text: 'remote', visibility: 'public', uri: `${inbox.origin}/notes/remote-base` });
	ids.base = codec.newId(Date.now());
	await source.getRepository(MiNote).insert({ id: ids.base, userId: bob, userHost: null, text: 'base', visibility: 'public' });
	ids.channel = codec.newId(Date.now());
	await source.getRepository(MiChannel).insert({ id: ids.channel, name: 'channel', userId: alice, isArchived: false, allowRenoteToExternal: false });
});

afterAll(async () => {
	await inbox?.close();
	await source?.destroy();
	await database?.close();
});

function processConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	const prefix = `note-deliver-process-${randomUUID()}`;
	return { ...database.config, redisForJobQueue: { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:` }, ...overrides };
}

async function create(port: number, name: string, input: Record<string, unknown>): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, ...input }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
	ids[name] = (await response.json() as { createdNote: { id: string } }).createdNote.id;
	return ids[name];
}

/** 実行ごとに変わる ID・origin・ポート・時刻を、本家の観測と同じ名前へ戻す。 */
function normalize(body: string, origin: string): unknown {
	let text = body.replaceAll(new URL(inbox.origin).host, new URL(observedInbox).host).replaceAll(origin, '$origin');
	for (const [name, id] of Object.entries(ids)) {
		text = text.replaceAll(id, `$${name}`);
	}
	return JSON.parse(text, (key, value: unknown) => (key === 'published' ? '$time' : value));
}

test('notes created over HTTP are delivered by the worker process to the fake inboxes like the pinned upstream (relay excluded)', async () => {
	const port = await freePort();
	const value = processConfig({ http: { port } });
	const config = await configuration(value);
	const http = launch('built/entrypoints/http.js', config.path);
	const worker = launch('built/entrypoints/worker.js', config.path);
	try {
		await Promise.all([http.ready, worker.ready]);

		for (const visibility of ['public', 'home', 'followers', 'specified']) {
			await create(port, `ap-${visibility}`, { text: 'AP contract', visibility, visibleUserIds: [ids.remote1], ...(visibility === 'public' ? { replyId: ids['remote-base'] } : {}) });
		}
		const local = await create(port, 'ap-local', { text: 'local', localOnly: true });
		const channel = await create(port, 'ap-channel', { text: 'channel', channelId: ids.channel });
		await create(port, 'ap-pure', { renoteId: ids.base });
		await create(port, 'ap-quote', { text: 'quote', renoteId: ids.base });

		// 本家の観測から relay（2 番目の #171 PR）を除いた宛先。
		const expected: Record<string, string[]> = {
			'ap-public': ['/inbox/shared'], 'ap-home': ['/inbox/shared'], 'ap-followers': ['/inbox/shared'], 'ap-specified': ['/inbox/remote1'],
			'ap-pure': ['/inbox/shared'], 'ap-quote': ['/inbox/shared'],
		};
		const total = Object.values(expected).flat().length;
		await vi.waitFor(() => {
			expect(inbox.deliveries).toHaveLength(total);
		}, { timeout: 20000, interval: 100 });
		// localOnly・channel の投稿の配送が遅れて届かないことを、有限の時間だけ確かめる。
		await new Promise(resolve => setTimeout(resolve, 500));
		expect(inbox.deliveries).toHaveLength(total);
		expect(inbox.deliveries.some(d => d.body.includes(local) || d.body.includes(channel))).toBe(false);

		for (const [name, paths] of Object.entries(expected)) {
			const key = `C9-${name.slice(3)}`;
			const received = inbox.deliveries.filter(d => d.body.includes(`/notes/${ids[name]}/activity`)).sort((a, b) => a.path.localeCompare(b.path));
			expect(received.map(d => d.path)).toEqual(paths);
			const upstream = (observations[key] as { path: string; activity: unknown; signed: boolean; digest: boolean }[]).filter(o => o.path !== '/inbox/relay');
			expect(received.map(d => ({ path: d.path, activity: normalize(d.body, value.url) }))).toEqual(upstream.map(o => ({ path: o.path, activity: o.activity })));
			for (const delivery of received) {
				expect(delivery.keyId).toBe(`${value.url}/users/${ids.alice}#main-key`);
				expect(delivery.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
			}
		}
		expect(observations['C9-localOnly']).toEqual({ deliveries: [] });

		http.child.kill('SIGTERM');
		worker.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0);
		expect((await worker.exit).code, worker.output()).toBe(0);
		expect(http.output()).not.toContain('note-post-save.failed');
		expect(worker.output()).not.toContain('job.failed');
		expect(worker.output()).not.toContain('deliver.instance-update-failed');
	} finally {
		await http.close();
		await worker.close();
		await config.close();
	}
});

test('losing the deliver queue connection of a worker stops the whole process tree abnormally', async () => {
	const value = processConfig({ http: { port: await freePort() } });
	const config = await configuration(value);
	const control = new Redis(database.config.redis);
	const supervisor = launch('built/entrypoints/supervisor.js', config.path);
	let children: { role: string; pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((message: any) => message.role === 'supervisor') as { children: typeof children }).children;
		let blocking: string | undefined;
		await vi.waitFor(async () => {
			blocking = String(await control.client('LIST')).split('\n')
				.find(line => line.includes(`name=${value.redisForJobQueue.prefix}:queue:deliver:`) && line.includes('cmd=bzpopmin'));
			expect(blocking).toBeDefined();
		}, { timeout: 5000, interval: 50 });
		await control.client('KILL', 'ID', blocking!.match(/^id=(\d+)/)![1]);

		expect((await supervisor.exit).code, supervisor.output()).toBe(1);
		expect(supervisor.output()).toContain('JOB_QUEUE_REDIS_ENDED');
		expect(supervisor.output()).toContain('"queue":"deliver"');
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
	} finally {
		control.disconnect();
		await supervisor.close();
		for (const child of children) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {}
		}
		await config.close();
	}
});
