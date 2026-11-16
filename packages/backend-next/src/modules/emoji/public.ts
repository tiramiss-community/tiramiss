/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface PublicEmoji {
	id: string;
	name: string;
	host: string | null;
	aliases: string[];
	category: string | null;
	publicUrl: string;
	originalUrl: string;
	license: string | null;
	localOnly: boolean;
	isSensitive: boolean;
	roleIdsThatCanBeUsedThisEmojiAsReaction: string[];
}

export function createPublicEmojis(reader: { list(): Promise<PublicEmoji[]>; findLocal(name: string): Promise<PublicEmoji> }) {
	return {
		async list() {
			return { emojis: (await reader.list()).map(emoji => ({
				aliases: emoji.aliases,
				name: emoji.name,
				category: emoji.category,
				url: emoji.publicUrl || emoji.originalUrl,
				localOnly: emoji.localOnly ? true : undefined,
				isSensitive: emoji.isSensitive ? true : undefined,
				roleIdsThatCanBeUsedThisEmojiAsReaction: emoji.roleIdsThatCanBeUsedThisEmojiAsReaction.length > 0 ? emoji.roleIdsThatCanBeUsedThisEmojiAsReaction : undefined,
			})) };
		},
		async show(name: string) {
			const emoji = await reader.findLocal(name);
			return {
				id: emoji.id,
				aliases: emoji.aliases,
				name: emoji.name,
				category: emoji.category,
				host: emoji.host,
				url: emoji.publicUrl || emoji.originalUrl,
				license: emoji.license,
				isSensitive: emoji.isSensitive,
				localOnly: emoji.localOnly,
				roleIdsThatCanBeUsedThisEmojiAsReaction: emoji.roleIdsThatCanBeUsedThisEmojiAsReaction,
			};
		},
	};
}
