/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { planFavoriteAchievement } from '../../../src/modules/note-personal-state/favorite-achievement.js';

test('first favorite appends exactly the grant and preserves existing achievement dates', () => {
	const existing = [{ name: 'notes1', unlockedAt: 10 }];
	expect(planFavoriteAchievement({ achievements: existing, notificationMode: null }, 20)).toEqual({ achievements: [...existing, { name: 'myNoteFavorited1', unlockedAt: 20 }], notify: true });
	expect(existing).toEqual([{ name: 'notes1', unlockedAt: 10 }]);
});

test('never suppresses notification but still grants; every other reception mode accepts no-notifier achievements', () => {
	for (const notificationMode of ['never', 'following', 'follower', 'mutualFollow', 'followingOrFollower', 'list', 'all', null]) {
		expect(planFavoriteAchievement({ achievements: [], notificationMode }, 20)).toEqual({ achievements: [{ name: 'myNoteFavorited1', unlockedAt: 20 }], notify: notificationMode !== 'never' });
	}
});

test('already earned achievement cannot produce another grant or notification', () => {
	expect(planFavoriteAchievement({ achievements: [{ name: 'myNoteFavorited1', unlockedAt: 10 }], notificationMode: null }, 20)).toBeNull();
});
