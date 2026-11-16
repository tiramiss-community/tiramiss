/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface ImageEmoji { publicUrl: string; originalUrl: string; }
export interface ImageUser { username: string; host: string | null; avatarId: string | null; avatarUrl: string | null; }
export interface AvatarImageReader {
	emoji(name: string, host: string | null): Promise<ImageEmoji | null>;
	user(usernameLower: string, host: string | null): Promise<ImageUser | null>;
}
export interface AvatarImageSettings { iconUrl: string | null; enableIdenticonGeneration: boolean; }

export function emojiImageUrl(emoji: ImageEmoji, mediaProxy: string, query: { badge: boolean; static: boolean }): string {
	const url = new URL(`${mediaProxy}/emoji.${query.badge ? 'png' : 'webp'}`);
	url.searchParams.set('url', emoji.publicUrl || emoji.originalUrl);
	url.searchParams.set(query.badge ? 'badge' : 'emoji', '1');
	if (!query.badge && query.static) {
		url.searchParams.set('static', '1');
	}
	return url.toString();
}

export function avatarImageUrl(user: ImageUser, url: string, iconUrl: string | null): string {
	const avatar = user.avatarId == null ? null : user.avatarUrl;
	if (avatar != null) {
		return avatar;
	}
	const host = new URL(url).host;
	if ((user.host == null || user.host === host) && user.username.includes('.') && iconUrl) {
		return iconUrl;
	}
	return `${url}/identicon/${user.username.toLowerCase()}@${user.host ?? host}`;
}

export function parseAvatarAcct(acct: string, localHost: string): { usernameLower: string; host: string | null } {
	const [username, host] = (acct.startsWith('@') ? acct.substring(1) : acct).split('@', 2);
	return { usernameLower: username.toLowerCase(), host: !host || host === localHost ? null : host };
}
