/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';

export interface UserFollowing {
	id: string;
	followeeId: string;
	followerId: string;
	isFollowerHibernated: boolean;
	withReplies: boolean;
	notify: 'normal' | null;
	followerHost: string | null;
	followerInbox: string | null;
	followerSharedInbox: string | null;
	followeeHost: string | null;
	followeeInbox: string | null;
	followeeSharedInbox: string | null;
}

/** Viewer-bound, fetched material reusable by detailed-user rendering without further IO. */
export interface UserRelationMaterials {
	following: readonly UserFollowing[];
	followedBy: readonly string[];
	requestsFromYou: readonly string[];
	requestsToYou: readonly string[];
	blocking: readonly string[];
	blockedBy: readonly string[];
	muted: readonly string[];
	renoteMuted: readonly string[];
}

export interface UserRelationReader {
	read(viewerId: string): Promise<UserRelationMaterials>;
}

export function userRelationsFromMaterials(targetIds: readonly string[], materials: UserRelationMaterials) {
	const following = new Map(materials.following.map(row => [row.followeeId, row]));
	const followed = new Set(materials.followedBy);
	const requestsFromYou = new Set(materials.requestsFromYou);
	const requestsToYou = new Set(materials.requestsToYou);
	const blocking = new Set(materials.blocking);
	const blockedBy = new Set(materials.blockedBy);
	const muted = new Set(materials.muted);
	const renoteMuted = new Set(materials.renoteMuted);
	return new Map(targetIds.map(id => [id, {
		id, following: following.get(id) ?? null,
		isFollowing: following.has(id), isFollowed: followed.has(id),
		hasPendingFollowRequestFromYou: requestsFromYou.has(id), hasPendingFollowRequestToYou: requestsToYou.has(id),
		isBlocking: blocking.has(id), isBlocked: blockedBy.has(id),
		isMuted: muted.has(id), isRenoteMuted: renoteMuted.has(id),
	}]));
}

const input = compileInput<{ userId: string | string[] }>({
	type: 'object',
	properties: { userId: { oneOf: [{ type: 'string', format: 'misskey:id' }, { type: 'array', items: { type: 'string', format: 'misskey:id' } }] } },
	required: ['userId'],
});

export function createUserRelation(ports: { reader: UserRelationReader; readActor(userId: string): Promise<AccessFacts> }) {
	return {
		async read(access: AccessRequest, raw: unknown) {
			const actor = requireCredential(access.credential);
			access.authorize(await ports.readActor(actor.userId));
			const params = input(raw);
			const targets = Array.isArray(params.userId) ? params.userId : [params.userId];
			return [...userRelationsFromMaterials(targets, await ports.reader.read(actor.userId)).values()];
		},
	};
}
