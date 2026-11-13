/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { emptyActorFields } from '../../helpers/local-actor.js';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { renderLocalActor } from '../../../src/modules/federation/public.js';
import { MiDriveFile, MiMeta, MiUserProfile } from 'backend-upstream/entities';
import { createLocalActorMaterialsReader } from '../../../src/composition/local-actor-materials.js';
import { createActivityPubActorApi } from '../../../src/http/activitypub-actor-api.js';
import { testConfig } from '../../helpers/database.js';
import type { EntityManager } from 'typeorm';
const root = new URL('../../../../../docs/superpowers/compatibility/remote-user/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('local-actor-images-corpus.json', root), 'utf8'));
const source = JSON.parse(readFileSync(new URL('local-actor-images-observations.json', root), 'utf8'));

// Missing images, wrong fallback/nullish semantics, or avatar-mode URLs break this independent pinned-source JSON.
for (const c of corpus.cases) {
	const expected = source.cases.find((row: { id: string }) => row.id === c.id).expected;
	if (expected.error) {
		continue;
	}
	test(`source ${c.id} publishes stored actor images and exact fallbacks`, () => {
		const defaults = corpus.defaults;
		const user = { ...emptyActorFields, ...defaults.user, ...c.user };
		const file = (id: string | null) => id && c.files?.[id] ? { ...defaults.file, ...c.files[id] } : null;
		const media = { ...defaults.meta, ...defaults.config, ...c.meta, ...c.config, avatar: file(user.avatarId), banner: file(user.bannerId) };
		const body = renderLocalActor(user, defaults.profile, defaults.config.url, 'key', [], media);
		expect(JSON.parse(JSON.stringify({ icon: body.icon, image: body.image }))).toEqual(expected.json);
	});
}

// Reordering acquisition/key/conversion, filtering by owner, or deduplicating IDs changes source-visible output/errors/reads.
for (const c of corpus.cases) {
	test(`source ${c.id} reaches HTTP through actual acquisition and preserves error priority`, async () => {
		const expected = source.cases.find((row: { id: string }) => row.id === c.id).expected;
		const defaults = corpus.defaults;
		const user = { ...emptyActorFields, ...defaults.user, ...c.user, uri: null };
		const events: { op: string; id?: string }[] = [];
		const manager = { getRepository(entity: unknown) {
			if (entity === MiDriveFile) {
				return { findOne: async ({ where }: { where: { id: string } }) => {
					events.push({ op: 'file', id: where.id });
					if (c.fail?.file === where.id) {
						throw Error(`file ${where.id} unavailable`);
					}
					return c.files?.[where.id] ? { ...defaults.file, ...c.files[where.id] } : null;
				} };
			}
			if (entity === MiUserProfile) {
				return { findOneOrFail: async () => {
					events.push({ op: 'profile' });
					if (c.fail?.profile) {
						throw Error('profile unavailable');
					}
					return defaults.profile;
				} };
			}
			if (entity === MiMeta) {
				return { find: async () => [{ ...defaults.meta, ...c.meta }] };
			}
			throw Error('unexpected repository');
		} } as unknown as EntityManager;
		const config = { ...testConfig(), url: defaults.config.url, noteMedia: { ...defaults.config, ...c.config } };
		let error: unknown;
		const app = createActivityPubActorApi({
			selfUrl: config.url, federationEnabled: async () => true, isSelfHost: () => false,
			readActor: async () => user, readMaterials: createLocalActorMaterialsReader(manager, config),
			readTags: async () => {
				events.push({ op: 'tags' });
				if (c.fail?.tags) {
					throw Error('tags unavailable');
				}
				return [];
			},
			publicKey: async () => {
				events.push({ op: 'key' });
				if (c.fail?.key) {
					throw Error('key unavailable');
				}
				return 'key';
			},
		});
		app.onError(caught => {
			error = { name: caught.name, message: caught.message };
			return new Response('failed', { status: 500 });
		});
		const response = await app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
		if (expected.error) {
			expect(response.status).toBe(500);
			expect(response.headers.get('cache-control')).toBeNull();
			expect(error).toEqual(expected.error);
		} else {
			expect(response.status).toBe(200);
			const body = await response.json();
			expect({ icon: body.icon, image: body.image }).toEqual(expected.json);
		}
		expect(events).toEqual(expected.events);
	});
}

test('pending avatar and banner reads start alongside profile and gate tags/key until all materials finish', async () => {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const allStarted = new Promise<void>(resolve => {
		started = resolve;
	});
	const reads: string[] = [];
	const later: string[] = [];
	const manager = { getRepository(entity: unknown) {
		if (entity === MiDriveFile) {
			return { findOne: async ({ where }: { where: { id: string } }) => {
				reads.push(where.id);
				await gate;
				return { ...corpus.defaults.file };
			} };
		}
		if (entity === MiUserProfile) {
			return { findOneOrFail: async () => {
				reads.push('profile'); started(); return corpus.defaults.profile;
			} };
		}
		return { find: async () => [corpus.defaults.meta] };
	} } as unknown as EntityManager;
	const config = testConfig();
	const app = createActivityPubActorApi({ selfUrl: config.url, federationEnabled: async () => true, isSelfHost: () => false,
		readActor: async () => ({ ...emptyActorFields, ...corpus.defaults.user, avatarId: 'a', bannerId: 'b', uri: null }), readMaterials: createLocalActorMaterialsReader(manager, config),
		readTags: async () => {
			later.push('tags'); return [];
		}, publicKey: async () => {
			later.push('key'); return 'key';
		},
	});
	const pending = app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
	await allStarted;
	const beforeRelease = { reads: [...reads], later: [...later] };
	release();
	const response = await pending;
	expect(beforeRelease).toEqual({ reads: ['a', 'b', 'profile'], later: [] });
	expect(later).toEqual(['tags', 'key']);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ icon: { url: 'https://files.test/original' }, image: { url: 'https://files.test/original' } });
});

// DB-backed Meta is an explicit extra failure boundary compared with upstream injected memory.
test('Meta acquisition failure returns an uncached error before tags/key', async () => {
	const defaults = corpus.defaults;
	let laterWork = false;
	const manager = { getRepository(entity: unknown) {
		if (entity === MiUserProfile) {
			return { findOneOrFail: async () => defaults.profile };
		}
		if (entity === MiMeta) {
			return { find: async () => {
				throw Error('Meta database unavailable');
			} };
		}
		throw Error('no file read expected');
	} } as unknown as EntityManager;
	const config = testConfig();
	const app = createActivityPubActorApi({ selfUrl: config.url, federationEnabled: async () => true, isSelfHost: () => false,
		readActor: async () => ({ ...emptyActorFields, ...defaults.user, uri: null }), readMaterials: createLocalActorMaterialsReader(manager, config),
		readTags: async () => {
			laterWork = true; return [];
		}, publicKey: async () => {
			laterWork = true; return 'key';
		},
	});
	let message: string | undefined;
	app.onError(error => {
		message = error.message; return new Response('failed', { status: 500 });
	});
	const response = await app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(500);
	expect(message).toBe('Meta database unavailable');
	expect(response.headers.get('cache-control')).toBeNull();
	expect(laterWork).toBe(false);
});
