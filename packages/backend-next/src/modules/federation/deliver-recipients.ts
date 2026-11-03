/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** 本家 DeliverManager の recipe。追加した順に処理する。 */
export type DeliverRecipe =
	| { type: 'Followers' }
	| { type: 'Direct'; to: { inbox: string | null; sharedInbox: string | null } };

/** following 表の、配送する利用者をフォローするリモートの行。 */
export interface FollowerInbox {
	followerSharedInbox: string | null;
	followerInbox: string | null;
}

export type NoteDeliveryErrorCode = 'FOLLOWER_INBOX_MISSING' | 'RENDER_FAILED';

/** 投稿を配送しなかった理由。log に残すため、外部の値を含まない code を持つ。 */
export class NoteDeliveryError extends Error {
	readonly name = 'NoteDeliveryError';

	constructor(readonly code: NoteDeliveryErrorCode, message: string, options?: { cause: unknown }) {
		super(message, options);
	}
}

/**
 * 本家 DeliverManager.execute の宛先。キーは inbox、値は shared inbox かどうかで、反復順が投入の順になる。
 * followers の行に inbox が 1 つもなければ、本家と同じく 1 件も返さずに失敗する。
 */
export async function collectInboxes(
	recipes: readonly DeliverRecipe[],
	readFollowerInboxes: () => Promise<readonly FollowerInbox[]>,
): Promise<Map<string, boolean>> {
	const inboxes = new Map<string, boolean>();

	// direct と同じ inbox を followers の shared inbox で済ませられるよう、followers を先に入れる。
	if (recipes.some(recipe => recipe.type === 'Followers')) {
		for (const following of await readFollowerInboxes()) {
			const inbox = following.followerSharedInbox ?? following.followerInbox;
			if (inbox === null) {
				throw new NoteDeliveryError('FOLLOWER_INBOX_MISSING', 'inbox is null');
			}
			inboxes.set(inbox, following.followerSharedInbox !== null);
		}
	}

	for (const recipe of recipes) {
		if (recipe.type !== 'Direct') {
			continue;
		}
		if (recipe.to.sharedInbox !== null && inboxes.has(recipe.to.sharedInbox)) {
			continue;
		}
		if (recipe.to.inbox === null) {
			continue;
		}
		inboxes.set(recipe.to.inbox, false);
	}

	return inboxes;
}
