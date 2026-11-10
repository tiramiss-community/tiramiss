/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { MiMeta } from 'backend-upstream/entities';
import { createRemoteEmojis } from '../../../src/composition/remote-emojis.js';
import { createRemoteUsers } from '../../../src/composition/remote-users.js';
import { createDataSource } from '../../../src/platform/database/data-source.js';
import { testConfig } from '../../helpers/database.js';
import { encode, decode } from '../../helpers/remote-source.js';
import type { RemoteEmoji, RemoteUserFacts } from '../../../src/modules/federation/public.js';

const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/remote-user/remote-emojis-observations.json', import.meta.url), 'utf8')) as { cases: { id: string; area: string; input: any; expected: any }[] };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(yes => {
		resolve = yes;
	});
	return { promise, resolve };
}

function harness(input: any) {
	const rows: RemoteEmoji[] = structuredClone(input.rows ?? []).map((r: any) => ({ ...r, updatedAt: r.updatedAt === null ? null : new Date(r.updatedAt) }));
	const events: { op: string; args?: unknown; }[] = [];
	const event = (op: string, args?: unknown) => events.push({ op, ...(args === undefined ? {} : { args: encode(args) }) });
	const held = deferred(); const entered = deferred();
	let nextId = 0;
	const controller = createRemoteEmojis({
		async find(host, names) {
			event('find', { host, names });
			if (input.fail === 'query') {
				throw Error('query failed');
			}
			return structuredClone(rows.filter(r => r.host === host && names.includes(r.name)));
		},
		async update(host, name, patch) {
			event('update', { host, name, patch });
			if (input.fail === 'update') {
				throw Error('update failed');
			}
			const row = rows.find(r => r.host === host && r.name === name)!;
			for (const [k, v] of Object.entries(patch)) {
				if (v !== undefined) {
					Object.assign(row, { [k]: v });
				}
			}
		},
		async findOne(host, name) {
			event('refetch', { host, name });
			return input.fail === 'update-refetch' ? null : structuredClone(rows.find(r => r.host === host && r.name === name) ?? null);
		},
		async insert(row) {
			event('insert.start', row);
			if (input.gate === row.name) {
				entered.resolve(); await held.promise;
			}
			if (input.fail === 'insert' || input.failName === row.name) {
				throw Error('insert failed');
			}
			if (rows.some(r => r.host === row.host && r.name === row.name)) {
				throw Object.assign(Error('duplicate emoji'), { code: '23505' });
			}
			rows.push({ ...row, uri: row.uri ?? null }); event('insert.done', { name: row.name }); await Promise.resolve(); event('insert.refetch', { id: row.id });
			if (input.fail === 'insert-refetch') {
				throw Error('insert refetch failed');
			}
			return structuredClone(rows.at(-1)!);
		},
	}, {
		now: () => 1800000000000, newId: () => {
			const id = `emoji-${++nextId}`; event('id', id); return id;
		}
	});
	return { rows, events, event, controller, held, entered };
}

test.each(source.cases.filter((c: any) => c.area === 'extract'))('$id matches frozen real source extraction observations', async (fixture: any) => {
	const input = decode(fixture.input) as any;
	const h = harness(input);
	const work = h.controller.extract(input.tags, input.host ?? 'remote.test');
	let result; let error;
	if (input.gate) {
		await h.entered.promise;
		if (input.failName) {
			try {
				await work;
			} catch (e) {
				error = { name: (e as Error).name, message: (e as Error).message };
			}
			h.event('response', { rows: h.rows });
		}
		h.held.resolve();
	}
	try {
		result = await work;
	} catch (e) {
		error = { name: (e as Error).name, message: (e as Error).message };
	}
	await h.controller.idle();
	expect({ ...(error ? { error } : { result: encode(result) }), events: h.events, rows: encode(h.rows) }).toEqual(fixture.expected);
});

test('early rejection returns while another full tag operation remains owned by close', async () => {
	const fixture = source.cases.find((c: any) => c.id === 'early-rejection')!;
	const input = decode(fixture.input) as any; const h = harness(input);
	const response = h.controller.extract(input.tags, 'remote.test');
	await h.entered.promise;
	await expect(response).rejects.toThrow('insert failed');
	let closed = false; const close = h.controller.close().then(() => {
		closed = true;
	});
	await Promise.resolve(); expect(closed).toBe(false); expect(h.rows).toHaveLength(0);
	h.held.resolve(); await close;
	expect(h.rows.map(r => r.name)).toEqual(['wave']);
});

test('close waits for an update refetch and a tag that starts during the drain', async () => {
	const refetchEntered = deferred();
	const refetchRelease = deferred();
	const insertEntered = deferred();
	const insertRelease = deferred();
	const wave: RemoteEmoji = { id: 'wave', name: 'wave', host: 'remote.test', uri: null, originalUrl: 'old', publicUrl: 'old', updatedAt: null, aliases: [], license: null };
	const controller = createRemoteEmojis({
		async find(_host, names) {
			return names.includes('wave') ? [wave] : [];
		},
		async update(_host, _name, patch) {
			wave.publicUrl = patch.publicUrl;
		},
		async findOne() {
			refetchEntered.resolve();
			await refetchRelease.promise;
			return wave;
		},
		async insert(row) {
			if (row.name === 'broken') {
				throw new Error('insert failed');
			}
			insertEntered.resolve();
			await insertRelease.promise;
			return { ...row, uri: null };
		},
	}, { now: () => 1800000000000, newId: () => 'spark' });
	const emojiTag = (name: string) => ({ type: 'Emoji', name: `:${name}:`, icon: { url: `https://remote.test/${name}.png` } });
	const response = controller.extract([emojiTag('wave'), emojiTag('broken')], 'remote.test');
	await expect(response).rejects.toThrow('insert failed');
	await refetchEntered.promise;
	let closed = false;
	const close = controller.close().then(() => {
		closed = true;
	});
	const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));

	try {
		await checkpoint();
		expect(closed).toBe(false);
		expect(wave.publicUrl).toBe('https://remote.test/wave.png');

		const late = controller.extract([emojiTag('spark')], 'remote.test');
		await insertEntered.promise;
		refetchRelease.resolve();
		await checkpoint();
		expect(closed).toBe(false);
		insertRelease.resolve();
		expect(await late).toMatchObject([{ name: 'spark' }]);
	} finally {
		refetchRelease.resolve();
		insertRelease.resolve();
		await close;
	}
});

const existing: RemoteUserFacts = { id: 'remote', username: 'Original', host: 'entry.test', uri: 'https://remote.test/users/a', lastFetchedAtMs: 0, isDeleted: false, tags: [], movedToUri: null };
const tag = { type: 'Emoji', name: ':wave:', icon: { url: 'https://remote.test/wave.png' } };

function acquisition(patch: Record<string, unknown> = {}, fail = false, extractor?: (tags: unknown, host: string) => Promise<RemoteEmoji[]>) {
	const events: string[] = []; const config = testConfig(); config.url = 'https://local.test';
	const dataSource = createDataSource(config.database);
	vi.spyOn(dataSource.getRepository(MiMeta), 'find').mockResolvedValue([Object.assign(new MiMeta(), { federation: 'all', signToActivityPubGet: false, blockedHosts: [], federationHosts: [], silencedHosts: [], mediaSilencedHosts: [], deliverSuspendedSoftware: [] })]);
	const ports = createRemoteUsers({
		logger: { info() { }, error() { } }, dataSource, userHashtags: { start() { } }, actorInstanceRegistration: { start() { } },
		remoteEmojis: {
			async extract(_tags, host) {
				events.push('extract:' + host); if (extractor) {
					return extractor(_tags, host);
				} if (fail) {
					throw Error('query failed');
				} return [{ name: 'wave' }] as RemoteEmoji[];
			}
		},
		outboundHttp: {
			async send(url: string) {
				events.push(url.includes('/following') ? 'collection' : 'actor');
				const body = url.includes('/following') ? { type: 'Collection', items: [] } : { type: 'Person', id: existing.uri, preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', tag: [tag], following: 'https://remote.test/following', ...patch };
				return { finalUrl: url, header: () => 'application/activity+json', json: async () => ({ '@context': 'https://www.w3.org/ns/activitystreams', ...body }) };
			}
		} as never, federationKeys: undefined as never,
	}, config);
	return { ports, events };
}

test.each([false, true])('real acquisition places extraction at the source create/refresh boundary (refresh=%s)', async refresh => {
	const h = acquisition();
	const plan = await h.ports.acquireActor(existing.uri!, refresh ? existing : null, () => {
		h.events.push('clock'); return 1800000000000;
	}, () => {
		h.events.push('actor.id'); return 'new-user';
	});
	expect(plan.user.emojis).toEqual(['wave']);
	expect(h.events).toEqual(refresh ? ['actor', 'extract:entry.test', 'collection', 'clock'] : ['actor', 'collection', 'extract:remote.test', 'clock', 'actor.id']);
});

test.each(['bad-url', 'bad-birthday'])('create preflight prevents extraction but refresh preserves its writes on %s', async kind => {
	for (const refresh of [false, true]) {
		const h = acquisition(kind === 'bad-url' ? { url: 'ftp://remote.test/a' } : { 'vcard:bday': 17 });
		await expect(h.ports.acquireActor(existing.uri!, refresh ? existing : null, Date.now, () => 'actor')).rejects.toThrow();
		expect(h.events.some(e => e.startsWith('extract:'))).toBe(refresh);
	}
});

test('query rejection is caught to empty actor names for create and refresh', async () => {
	for (const refresh of [false, true]) {
		const h = acquisition({}, true);
		const plan = await h.ports.acquireActor(existing.uri!, refresh ? existing : null, Date.now, () => 'actor');
		expect(plan.user.emojis).toEqual([]);
	}
});

test.each(source.cases.filter((c: any) => c.area !== 'extract' && !c.input.actorFail && !c.input.duplicate && !c.input.deleted))('$id actual acquisition matches source names, extraction writes and preflight failures', async (fixture: any) => {
	const input = decode(fixture.input) as any; const h = harness(input);
	const a = acquisition({ tag: [{ ...tag, id: 'https://remote.test/emoji/wave', updated: '2026-01-01' }], ...(input.patch ?? {}) }, false, h.controller.extract);
	const entry = { ...existing, host: input.entryHost ?? 'remote.test' };
	let plan; let error;
	try {
		plan = await a.ports.acquireActor(existing.uri!, fixture.area === 'refresh' ? entry : null, () => 1800000000000, () => 'new-user');
	} catch (e) {
		error = e as Error;
	}
	await h.controller.idle();
	if (fixture.expected.error) {
		expect(error?.name).toBe(fixture.expected.error.name);
	} else {
		expect(error).toBeUndefined();
		const write = fixture.expected.events.find((e: any) => e.op === (fixture.area === 'refresh' ? 'User.update' : 'User.save'));
		expect(plan?.user.emojis).toEqual(write.args.emojis);
	}
	expect(encode(h.rows)).toEqual(fixture.expected.rows);
});
