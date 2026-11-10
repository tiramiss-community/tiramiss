/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { normalizeHashtag } from '../hashtag/public.js';

export interface UserHashtagSnapshot {
	id: string;
	host: string | null;
	tags: readonly string[];
}
export interface UserHashtagChange {
	tag: string;
	userId: string;
	userHost: string | null;
	attached: boolean;
}
export type StartUserHashtags = (user: UserHashtagSnapshot, tags: readonly string[]) => void;

export function planUserHashtags(user: UserHashtagSnapshot, tags: readonly string[]): UserHashtagChange[] {
	// Source compares raw old/new tags before normalizing each operation; collisions can add then remove.
	return [
		...tags.map(tag => ({ tag, attached: true })),
		...user.tags.filter(tag => !tags.includes(tag)).map(tag => ({ tag, attached: false })),
	].map(change => ({ ...change, tag: normalizeHashtag(change.tag), userId: user.id, userHost: user.host }));
}
