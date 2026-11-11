/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface ApEmojiFacts {
	name: string;
	type: string | null;
	publicUrl: string;
	originalUrl: string;
	license: string | null;
	localOnly: boolean;
	updatedAtMs: number | null;
}

export function renderApEmoji(emoji: ApEmojiFacts, selfUrl: string, now: number) {
	return {
		id: `${selfUrl}/emojis/${emoji.name}`,
		type: 'Emoji' as const,
		name: `:${emoji.name}:`,
		updated: new Date(emoji.updatedAtMs ?? now).toISOString(),
		icon: {
			type: 'Image' as const,
			mediaType: emoji.type ?? 'image/png',
			// publicUrl may be empty in historical rows.
			url: emoji.publicUrl || emoji.originalUrl,
		},
		_misskey_license: { freeText: emoji.license },
	};
}

export function renderApHashtag(name: string, selfUrl: string) {
	return { type: 'Hashtag' as const, href: `${selfUrl}/tags/${encodeURIComponent(name)}`, name: `#${name}` };
}

export type LocalActorTag = ReturnType<typeof renderApEmoji> | ReturnType<typeof renderApHashtag>;
