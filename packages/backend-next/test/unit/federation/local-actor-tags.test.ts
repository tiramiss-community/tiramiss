/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { emptyActorFields, emptyActorMedia } from '../../helpers/local-actor.js';
import { readFileSync } from 'node:fs';
import type { EntityManager } from 'typeorm';
import { expect, test } from 'vitest';
import { createActivityPubActorApi } from '../../../src/http/activitypub-actor-api.js';
import { renderLocalActor } from '../../../src/modules/federation/public.js';
const user = { ...emptyActorFields, id: 'local', avatarId: null, bannerId: null, username: 'alice', name: null, isBot: false, isLocked: false, isExplorable: true, emojis: [], tags: [], host: null, uri: null };
const profile = { description: null, followedMessage: null, fields: [], birthday: null, location: null };
const base = { selfUrl: 'https://local.test', federationEnabled: async () => true, isSelfHost: () => false, readActor: async () => user, readMaterials: async () => ({ profile: profile, media: emptyActorMedia }), readTags: async () => [], publicKey: async () => 'key' };

// Omitting tag from the actor body must break an externally visible result.
test('empty local actor explicitly publishes tag array', () => {
	expect(renderLocalActor(user, profile, base.selfUrl, 'key', [], emptyActorMedia).tag).toEqual([]);
});

test('HTTP publishes acquired tags before it reads the key', async () => {
	const events: string[] = [];
	const tag = [{ type: 'Hashtag' as const, href: 'https://local.test/tags/visible', name: '#visible' }];
	const app = createActivityPubActorApi({ ...base,
		readMaterials: async () => {
			events.push('profile');
			return { profile: profile, media: emptyActorMedia };
		},
		readTags: async () => {
			events.push('tags');
			return tag;
		},
		publicKey: async () => {
			events.push('key');
			return 'key';
		},
	});
	const response = await app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(200);
	expect((await response.json()).tag).toEqual(tag);
	expect(events).toEqual(['profile', 'tags', 'key']);
});

test('HTTP tag acquisition failure returns uncached error and does not read the key', async () => {
	let keyRead = false;
	const app = createActivityPubActorApi({ ...base, readTags: async () => {
		throw Error('emoji unavailable');
	}, publicKey: async () => {
		keyRead = true;
		return 'key';
	} });
	app.onError(() => new Response('failed', { status: 500 }));
	const response = await app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(500);
	expect(keyRead).toBe(false);
	expect(response.headers.get('cache-control')).toBeNull();
});

// The oracle ran pinned upstream methods; none of these expectations come from the port.
const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/remote-user/local-actor-tags-observations.json', import.meta.url), 'utf8'));
for (const fixture of source.cases) {
	test(`source ${fixture.id} preserves actor tag projection, clock and failure ordering`, async () => {
		const { createLocalActorTagReader } = await import('../../../src/composition/local-actor-tags.js');
		const events: { op: string; value?: number }[] = [];
		let time = source.epoch;
		const manager = { getRepository: () => ({ findBy: async () => {
			events.push({ op: 'emojis' });
			if (fixture.cacheFailure) {
				throw Error('emoji unavailable');
			}
			return fixture.rows.map((row: { updatedAt: string | null }) => ({ ...row, updatedAt: row.updatedAt === null ? null : new Date(row.updatedAt) }));
		} }) } as unknown as EntityManager;
		const readTags = createLocalActorTagReader(manager, base.selfUrl, () => {
			events.push({ op: 'clock', value: time }); return time++;
		});
		let caught: { name: string; message: string } | undefined;
		const app = createActivityPubActorApi({ ...base, readActor: async () => ({ ...user, emojis: fixture.names, tags: fixture.tags }), readTags,
			readMaterials: async () => {
				events.push({ op: 'profile' });
				if (fixture.profileFailure) {
					throw Error('profile unavailable');
				}
				return { profile: profile, media: emptyActorMedia };
			},
			publicKey: async () => {
				events.push({ op: 'key' });
				time += fixture.keyAdvanceMs ?? 0;
				if (fixture.keyFailure) {
					throw Error('key unavailable');
				}
				return 'key';
			},
		});
		app.onError(error => {
			caught = { name: error.name, message: error.message };
			return new Response('failed', { status: 500 });
		});
		const response = await app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
		if (fixture.expected.error) {
			expect(response.status).toBe(500);
			expect(caught).toEqual(fixture.expected.error);
			expect(response.headers.get('cache-control')).toBeNull();
		} else {
			expect(response.status).toBe(200);
			expect((await response.json()).tag).toEqual(fixture.expected.tag);
		}
		expect(events).toEqual(fixture.expected.events.filter((event: { op: string }) => !['emoji', 'hashtag'].includes(event.op)));
	});
}

test.each(['html', 'disabled', 'missing', 'remote'])('HTTP %s bypasses tag acquisition', async kind => {
	const app = createActivityPubActorApi({ ...base, federationEnabled: async () => kind !== 'disabled', readActor: async () => kind === 'missing' ? null : { ...user, host: kind === 'remote' ? 'remote.test' : null, uri: 'https://remote.test/user' },
		readTags: async () => {
			throw Error('must not read emojis');
		}, publicKey: async () => {
			throw Error('must not read key');
		},
	});
	const response = await app.request('/users/local', { headers: { Accept: kind === 'html' ? 'text/html' : 'application/activity+json' } });
	expect(response.status).toBe(kind === 'disabled' ? 403 : kind === 'remote' ? 301 : 404);
});

test('pending tag read gates the key and undated emoji time precedes pending key completion', async () => {
	const { createLocalActorTagReader } = await import('../../../src/composition/local-actor-tags.js');
	let releaseRead!: () => void;
	let releaseKey!: () => void;
	let markReadStarted!: () => void;
	let markKeyStarted!: () => void;
	const readStarted = new Promise<void>(resolve => {
		markReadStarted = resolve;
	});
	const keyStarted = new Promise<void>(resolve => {
		markKeyStarted = resolve;
	});
	const readGate = new Promise<void>(resolve => {
		releaseRead = resolve;
	});
	const keyGate = new Promise<void>(resolve => {
		releaseKey = resolve;
	});
	let keyRead = false;
	let now = 1000;
	const manager = { getRepository: () => ({ findBy: async () => {
		markReadStarted(); await readGate;
		return [{ name: 'alpha', type: null, publicUrl: '', originalUrl: 'https://original.test/alpha', license: null, localOnly: false, updatedAt: null }];
	} }) } as unknown as EntityManager;
	const app = createActivityPubActorApi({ ...base, readActor: async () => ({ ...user, emojis: ['alpha', 'alpha'] }), readTags: createLocalActorTagReader(manager, base.selfUrl, () => now++), publicKey: async () => {
		keyRead = true; markKeyStarted(); await keyGate; return 'key';
	} });
	const pending = app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
	await readStarted;
	const keyBeforeEmojis = keyRead;
	releaseRead();
	await keyStarted;
	now = 60000;
	releaseKey();
	const response = await pending;
	expect(keyBeforeEmojis).toBe(false);
	expect((await response.json()).tag.map((tag: { updated: string }) => tag.updated)).toEqual(['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.001Z']);
});
