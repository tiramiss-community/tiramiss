/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { toPuny } from './host.js';

export interface RemoteEmoji {
	id: string;
	name: string;
	host: string | null;
	uri: string | null;
	originalUrl: string;
	publicUrl: string;
	updatedAt: Date | null;
	aliases: readonly string[];
	license: string | null;
}
export interface RemoteEmojiPatch {
	uri: string | null | undefined;
	originalUrl: string;
	publicUrl: string;
	updatedAt: Date;
	license: string | null;
}
export interface RemoteEmojiInsert extends RemoteEmojiPatch {
	id: string;
	host: string;
	name: string;
	aliases: string[];
}
export interface RemoteEmojiRepository {
	find(host: string, names: string[]): Promise<RemoteEmoji[]>;
	update(host: string, name: string, patch: RemoteEmojiPatch): Promise<void>;
	findOne(host: string, name: string): Promise<RemoteEmoji | null>;
	insert(input: RemoteEmojiInsert): Promise<RemoteEmoji>;
}
export interface RemoteEmojiPorts extends RemoteEmojiRepository {
	now(): number;
	newId(): string;
	track(work: Promise<RemoteEmoji>): void;
}
interface EmojiTag {
	type?: string | string[];
	name: string;
	id?: string | null;
	updated: string;
	icon: { url: string };
	_misskey_license?: { freeText?: string | null };
}

export async function extractRemoteEmojis(tags: unknown, host: string, ports: RemoteEmojiPorts): Promise<RemoteEmoji[]> {
	host = toPuny(host);
	// The source predicate deliberately throws on malformed null objects or missing icons.
	const emojiTags = (Array.isArray(tags) ? tags : tags != null ? [tags] : []).filter((tag: EmojiTag) => {
		const type = typeof tag.type === 'string' ? tag.type : Array.isArray(tag.type) ? tag.type[0] : null;
		return type === 'Emoji' && !Array.isArray(tag.icon) && tag.icon.url != null;
	}) as EmojiTag[];
	const existing = await ports.find(host, emojiTags.map(tag => tag.name.replaceAll(':', '')));
	const work = emojiTags.map(async tag => {
		const name = tag.name.replaceAll(':', '');
		const row = existing.find(emoji => emoji.name === name);
		if (row) {
			if (row.updatedAt == null || (tag.id != null && row.uri == null) || new Date(tag.updated) > row.updatedAt || tag.icon.url !== row.originalUrl) {
				await ports.update(host, name, { uri: tag.id, originalUrl: tag.icon.url, publicUrl: tag.icon.url, updatedAt: new Date(ports.now()), license: tag._misskey_license?.freeText ?? null });
				const updated = await ports.findOne(host, name);
				if (updated == null) {
					throw new Error('emoji update failed');
				}
				return updated;
			}
			return row;
		}
		return await ports.insert({ id: ports.newId(), host, name, uri: tag.id, originalUrl: tag.icon.url, publicUrl: tag.icon.url, updatedAt: new Date(ports.now()), aliases: [], license: tag._misskey_license?.freeText ?? null });
	});
	for (const promise of work) {
		ports.track(promise);
	}
	return await Promise.all(work);
}
