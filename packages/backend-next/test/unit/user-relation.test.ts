/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { userRelationsFromMaterials } from '../../src/modules/user-relation/public.js';
import type { UserRelationMaterials } from '../../src/modules/user-relation/public.js';

const empty: UserRelationMaterials = { following: [], followedBy: [], requestsFromYou: [], requestsToYou: [], blocking: [], blockedBy: [], muted: [], renoteMuted: [] };
test('pure material conversion preserves target order, deduplicates and returns explicit empty relations', () => {
	const result = userRelationsFromMaterials(['unknown', 'empty', 'unknown'], empty);
	expect([...result.keys()]).toEqual(['unknown', 'empty']);
	expect([...result.values()]).toEqual(['unknown', 'empty'].map(id => ({ id, following: null, isFollowing: false, isFollowed: false, hasPendingFollowRequestFromYou: false, hasPendingFollowRequestToYou: false, isBlocking: false, isBlocked: false, isMuted: false, isRenoteMuted: false })));
	expect(userRelationsFromMaterials([], empty).size).toBe(0);
});
test('incoming and outgoing facts remain independent without fetching or mutating material', () => {
	const materials = { ...empty, followedBy: ['target'], requestsFromYou: ['target'], blockedBy: ['target'], renoteMuted: ['target'] };
	const before = structuredClone(materials);
	expect(userRelationsFromMaterials(['target'], materials).get('target')).toEqual({ id: 'target', following: null, isFollowing: false, isFollowed: true, hasPendingFollowRequestFromYou: true, hasPendingFollowRequestToYou: false, isBlocking: false, isBlocked: true, isMuted: false, isRenoteMuted: true });
	expect(materials).toEqual(before);
});
