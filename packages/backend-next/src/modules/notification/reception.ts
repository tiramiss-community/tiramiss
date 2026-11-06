/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface NotificationReception {
	recipientId: string;
	notifierId: string | null;
	mode: string | null;
	muted: boolean;
	followsNotifier: boolean;
	followedByNotifier: boolean;
	listContainsNotifier: boolean;
}

export function receivesPostNotification(facts: NotificationReception): boolean {
	if (facts.mode === 'never') {
		return false;
	}
	if (facts.notifierId === null) {
		return true;
	}
	if (facts.recipientId === facts.notifierId || facts.muted) {
		return false;
	}
	switch (facts.mode) {
		case 'following': return facts.followsNotifier;
		case 'follower': return facts.followedByNotifier;
		case 'mutualFollow': return facts.followsNotifier && facts.followedByNotifier;
		case 'followingOrFollower': return facts.followsNotifier || facts.followedByNotifier;
		case 'list': return facts.listContainsNotifier;
		default: return true;
	}
}
