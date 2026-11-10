/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { substring } from 'stringz';
import { OutboundStatusError } from '../../application/outbound-http.js';
import { punyHost } from './host.js';
import type { UserHashtagSnapshot, StartUserHashtags } from './user-hashtags.js';
import type { RemoteUserFacts, ResolvedUser } from './remote-user.js';

export type Visibility = 'public' | 'private';
export interface Actor {
	id: string;
	type: string | string[];
	inbox: string;
	preferredUsername: string;
	name?: string;
	summary?: string;
	publicKey?: {
		id: string;
		publicKeyPem: string;
	};
	sharedInbox?: string;
	endpoints?: {
		sharedInbox?: string;
	};
	outbox?: unknown;
	followers?: unknown;
	following?: unknown;
	featured?: unknown;
	manuallyApprovesFollowers?: boolean;
	discoverable?: boolean;
	movedTo?: string;
	alsoKnownAs?: string | string[];
	isCat?: boolean;
	requireSigninToViewContents?: boolean;
	makeNotesFollowersOnlyBefore?: number | null;
	makeNotesHiddenBefore?: number | null;
	tag?: unknown;
	attachment?: unknown;
	url?: unknown;
	_misskey_summary?: string;
	_misskey_followedMessage?: string;
	'vcard:bday'?: string;
	'vcard:Address'?: string;
	icon?: unknown;
	image?: unknown;
}
export interface RemoteActorMaterial {
	actor: Actor;
	host: string;
	followingVisibility?: Visibility;
	followersVisibility?: Visibility;
	description?: string | null;
	profileError?: {
		name: string;
		message: string;
	};
	fields?: {
		name: string;
		value: string;
	}[];
}
export interface RemoteActorUser {
	id?: string;
	avatarId?: null;
	bannerId?: null;
	lastFetchedAt: Date;
	name: string | undefined;
	isLocked: boolean | undefined;
	movedToUri: string | null | undefined;
	movedAt?: Date | null;
	alsoKnownAs: string[] | null;
	isExplorable: boolean | undefined;
	username?: string;
	usernameLower?: string;
	host?: string;
	inbox: string;
	sharedInbox: string | null;
	followersUri: string | undefined;
	featured: string | undefined;
	uri?: string;
	tags: string[];
	isBot: boolean;
	isCat: boolean;
	emojis: string[];
	requireSigninToViewContents?: boolean;
	makeNotesFollowersOnlyBefore?: number | null;
	makeNotesHiddenBefore?: number | null;
	avatarUrl?: null;
	avatarBlurhash?: null;
	bannerUrl?: null;
	bannerBlurhash?: null;
}
export interface RemoteActorProfile {
	userId?: string;
	userHost?: string;
	description: string | null;
	followedMessage: string | null;
	url: string | undefined;
	fields: {
		name: string;
		value: string;
	}[];
	followingVisibility: Visibility | undefined;
	followersVisibility: Visibility | undefined;
	birthday: string | null;
	location: string | null;
}
export interface RemoteActorPublickey {
	userId?: string;
	keyId: string;
	keyPem: string;
}
export interface RemoteActorPlan {
	kind: 'create' | 'refresh';
	hashtagUser: UserHashtagSnapshot;
	id: string;
	uri: string;
	user: RemoteActorUser;
	profile: RemoteActorProfile;
	publickey?: RemoteActorPublickey;
	profileError?: {
		name: string;
		message: string;
	};
}
export interface RemoteActorCreateScope {
	insertUser(user: RemoteActorUser): Promise<void>;
	insertProfile(profile: RemoteActorProfile): Promise<void>;
	insertPublickey(key: RemoteActorPublickey): Promise<void>;
}
export function apType(value: unknown): string | null {
	if (!value || typeof value !== 'object' || !('type' in value)) {
		return null;
	}
	const type = Array.isArray(value.type) ? value.type[0] : value.type;
	return typeof type === 'string' ? type : null;
}
export function apId(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	const id = value != null ? (value as { id?: unknown; }).id : undefined;
	if (typeof id === 'string') {
		return id;
	}
	throw new Error('cannot determine id');
}

function href(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		value = value[0];
	}
	if (typeof value === 'string') {
		return value;
	}
	return value && typeof value === 'object' && 'href' in value && typeof value.href === 'string' ? value.href : undefined;
}

export const truncate = (value: string | undefined, size: number) => value ? substring(value, 0, size) : value;
export function validateActor(value: unknown, requestedUri: string): RemoteActorMaterial {
	if (!value || typeof value !== 'object') {
		throw new Error('invalid Actor');
	}
	const x = structuredClone(value) as Actor;
	const host = punyHost(requestedUri);
	if (!['Person', 'Service', 'Group', 'Organization', 'Application'].includes(apType(x) ?? '')) {
		throw new Error(`invalid Actor type '${x.type}'`);
	}
	if (!(typeof x.id === 'string' && x.id.length > 0)) {
		throw new Error('invalid Actor: wrong id');
	}
	if (!(typeof x.inbox === 'string' && x.inbox.length > 0)) {
		throw new Error('invalid Actor: wrong inbox');
	}
	if (punyHost(x.inbox) !== host) {
		throw new Error('invalid Actor: inbox has different host');
	}
	const shared = x.sharedInbox ?? x.endpoints?.sharedInbox;
	if (shared != null) {
		const id = apId(shared);
		if (!(typeof id === 'string' && id.length > 0 && new URL(id).host === host)) {
			x.sharedInbox = undefined;
			if (x.endpoints?.sharedInbox) {
				x.endpoints.sharedInbox = undefined;
			}
		}
	}
	for (const collection of ['outbox', 'followers', 'following'] as const) {
		if (x[collection] != null) {
			const id = apId(x[collection]);
			if (typeof id === 'string' && id.length > 0) {
				if (punyHost(id) !== host) {
					throw new Error(`invalid Actor: ${collection} has different host`);
				}
			} else if (id != null) {
				throw new Error(`invalid Actor: wrong ${collection}`);
			}
		}
	}
	if (!(typeof x.preferredUsername === 'string' && x.preferredUsername.length > 0 && x.preferredUsername.length <= 128 && /^\w([\w-.]*\w)?$/.test(x.preferredUsername))) {
		throw new Error('invalid Actor: wrong username');
	}
	if (x.name) {
		if (typeof x.name !== 'string') {
			throw new Error('invalid Actor: wrong name');
		}
		x.name = truncate(x.name, 128);
	} else if (x.name === '') {
		x.name = undefined;
	}
	if (x.summary) {
		if (typeof x.summary !== 'string') {
			throw new Error('invalid Actor: wrong summary');
		}
		x.summary = truncate(x.summary, 2048);
	}
	if (punyHost(x.id) !== host) {
		throw new Error('invalid Actor: id has different host');
	}
	if (x.publicKey) {
		if (typeof x.publicKey.id !== 'string') {
			throw new Error('invalid Actor: publicKey.id is not a string');
		}
		if (punyHost(x.publicKey.id) !== host) {
			throw new Error('invalid Actor: publicKey.id has different host');
		}
	}
	return { actor: x, host };
}
export async function collectionVisibility(value: unknown, resolve: (value: string | Record<string, unknown>) => Promise<Record<string, unknown>>, refresh: boolean): Promise<Visibility | undefined> {
	try {
		if (!value) {
			return 'private';
		}
		const resolved = await resolve(value as string | Record<string, unknown>);
		if (apType(resolved) !== 'Collection' && apType(resolved) !== 'OrderedCollection') {
			throw new Error('unrecognized collection type');
		}
		return resolved.first || resolved.items || resolved.orderedItems ? 'public' : 'private';
	} catch (error) {
		return refresh && (!(error instanceof OutboundStatusError) || error.isRetryable) ? undefined : 'private';
	}
}

function isMissingImage(value: unknown): boolean {
	if (Array.isArray(value)) {
		value = value.find(item => item && item.url) ?? null;
	}
	return value == null || (typeof value === 'object' && (!('url' in value) || value.url == null));
}

export async function prepareActor(material: RemoteActorMaterial, existing: RemoteUserFacts | null, now: number, newId: string): Promise<RemoteActorPlan> {
	const { actor: p, host } = material;
	const refresh = existing !== null;
	const id = existing?.id ?? newId;
	const url = href(p.url);
	if ((refresh ? url != null : !!url) && !(url!.startsWith('https://') || (url!.startsWith('http://') && process.env.NODE_ENV !== 'production'))) {
		throw new Error('unexpected schema of person url: ' + url);
	}
	if (refresh && url != null && punyHost(url) !== punyHost(p.id)) {
		throw new Error(`person url <> uri host mismatch: ${url} <> ${p.id}`);
	}
	const tags = (Array.isArray(p.tag) ? p.tag : p.tag ? [p.tag] : []).flatMap(tag => {
		if (apType(tag) !== 'Hashtag' || typeof tag.name !== 'string') {
			return [];
		}
		const match = tag.name.match(/^#(.+)/);
		return match ? [match[1].normalize('NFKC').toLowerCase()] : [];
	}).splice(0, 32);
	const user: RemoteActorUser = {
		lastFetchedAt: new Date(now), inbox: p.inbox, sharedInbox: p.sharedInbox ?? p.endpoints?.sharedInbox ?? null,
		followersUri: p.followers ? apId(p.followers) : undefined, featured: p.featured ? apId(p.featured) : undefined,
		emojis: [], name: truncate(p.name, 128), tags, isBot: apType(p) === 'Service' || apType(p) === 'Application', isCat: p.isCat === true,
		isLocked: p.manuallyApprovesFollowers, movedToUri: refresh ? p.movedTo ?? null : p.movedTo,
		alsoKnownAs: refresh && !p.alsoKnownAs ? null : p.alsoKnownAs == null ? [] : Array.isArray(p.alsoKnownAs) ? p.alsoKnownAs : [p.alsoKnownAs], isExplorable: p.discoverable,
	};
	if (refresh) {
		if (p.movedTo && p.movedTo !== existing.movedToUri) {
			user.movedAt = new Date(now);
		}
		// Explicit removal of absent images is core state; actual media acquisition remains unsupported.
		if (isMissingImage(p.icon)) {
			Object.assign(user, { avatarId: null, avatarUrl: null, avatarBlurhash: null });
		}
		if (isMissingImage(p.image)) {
			Object.assign(user, { bannerId: null, bannerUrl: null, bannerBlurhash: null });
		}
	} else {
		Object.assign(user, {
			id, avatarId: null, bannerId: null, movedAt: p.movedTo ? new Date(now) : null,
			username: p.preferredUsername, usernameLower: p.preferredUsername.toLowerCase(), host, uri: p.id,
			requireSigninToViewContents: p.requireSigninToViewContents === true, makeNotesFollowersOnlyBefore: p.makeNotesFollowersOnlyBefore ?? null, makeNotesHiddenBefore: p.makeNotesHiddenBefore ?? null,
		});
	}
	let followedMessage: string | null = null;
	let profileError = material.profileError;
	if (!profileError) {
		try {
			followedMessage = p._misskey_followedMessage != null ? truncate(p._misskey_followedMessage, 256)! : null;
		} catch (error) {
			// Profile conversion follows committed User/Key refreshes in the source.
			profileError = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) };
		}
	}
	const profile: RemoteActorProfile = {
		...(refresh ? {} : { userId: id, userHost: host }), description: material.description ?? null,
		followedMessage,
		url, fields: material.fields ?? [], followingVisibility: material.followingVisibility, followersVisibility: material.followersVisibility,
		birthday: p['vcard:bday']?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null, location: p['vcard:Address'] ?? null,
	};
	return {
		kind: refresh ? 'refresh' : 'create', id, uri: p.id, user, profile,
		hashtagUser: { id, host: existing?.host ?? host, tags: [...(existing?.tags ?? tags)] },
		...(profileError ? { profileError } : {}),
		...(p.publicKey ? { publickey: { ...(refresh ? {} : { userId: id }), keyId: p.publicKey.id, keyPem: p.publicKey.publicKeyPem } } : {}),
	};
}
export async function insertActor(scope: RemoteActorCreateScope, plan: RemoteActorPlan): Promise<ResolvedUser> {
	await scope.insertUser(plan.user);
	if (plan.profileError) {
		throw Object.assign(new Error(plan.profileError.message), { name: plan.profileError.name });
	}
	await scope.insertProfile(plan.profile);
	if (plan.publickey) {
		await scope.insertPublickey(plan.publickey);
	}
	return { id: plan.id, username: plan.user.username!, host: plan.user.host!, uri: plan.uri };
}

export interface RemoteActorUpdates {
	updateUser(id: string, user: RemoteActorUser): Promise<boolean>;
	updatePublickey(id: string, key: RemoteActorPublickey): Promise<void>;
	updateProfile(id: string, profile: RemoteActorProfile): Promise<void>;
	updateFollowing(id: string, sharedInbox: string | null): Promise<void>;
}
export function createActorRefresher(writes: RemoteActorUpdates, startUserHashtags: StartUserHashtags) {
	return async (id: string, plan: RemoteActorPlan): Promise<'updated' | 'skip'> => {
		if (!await writes.updateUser(id, plan.user)) {
			return 'skip';
		}
		if (plan.publickey) {
			await writes.updatePublickey(id, plan.publickey);
		}
		if (plan.profileError) {
			throw Object.assign(new Error(plan.profileError.message), { name: plan.profileError.name });
		}
		await writes.updateProfile(id, plan.profile);
		startUserHashtags(plan.hashtagUser, plan.user.tags);
		await writes.updateFollowing(id, plan.user.sharedInbox);
		return 'updated';
	};
}
