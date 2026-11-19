/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export const favoriteAchievement = 'myNoteFavorited1';
export interface FavoriteAchievementProfile {
	achievements: { name: string; unlockedAt: number }[];
	notificationMode: string | null;
}

/** Granted under the caller's profile lock; notification runs after this update commits. */
export function planFavoriteAchievement(profile: FavoriteAchievementProfile, now: number): {
	achievements: FavoriteAchievementProfile['achievements'];
	notify: boolean;
} | null {
	if (profile.achievements.some(achievement => achievement.name === favoriteAchievement)) {
		return null;
	}
	return { achievements: [...profile.achievements, { name: favoriteAchievement, unlockedAt: now }], notify: profile.notificationMode !== 'never' };
}
