/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiDriveFile, MiUser, MiUserProfile } from 'backend-upstream/entities';
import type { ActorFileFacts, LocalActorProfileFacts } from '../../modules/federation/public.js';
import type { EntityManager } from 'typeorm';
export function createActorReader(manager: EntityManager, options: {
	includeSuspended?: boolean;
} = {}) {
	return async (id: string) => {
		const row = await manager.getRepository(MiUser).findOneBy(options.includeSuspended ? { id } : { id, isSuspended: false });
		if (!row) {
			return null;
		}
		const { avatarId, bannerId, username, name, isBot, isLocked, isExplorable, emojis, tags, host, uri,
			isCat, requireSigninToViewContents, makeNotesFollowersOnlyBefore, makeNotesHiddenBefore, movedToUri, alsoKnownAs } = row;
		return { id, avatarId, bannerId, username, name, isBot, isLocked, isExplorable, emojis, tags, host, uri,
			isCat, requireSigninToViewContents, makeNotesFollowersOnlyBefore, makeNotesHiddenBefore, movedToUri, alsoKnownAs };
	};
}

export function createActorProfileReader(manager: EntityManager): (id: string) => Promise<LocalActorProfileFacts> {
	return async id => {
		const { description, followedMessage, fields, birthday, location } = await manager.getRepository(MiUserProfile).findOneOrFail({
			where: { userId: id }, select: { description: true, followedMessage: true, fields: true, birthday: true, location: true },
		});
		return { description, followedMessage, fields, birthday, location };
	};
}

export function createActorFileReader(manager: EntityManager): (id: string) => Promise<ActorFileFacts | null> {
	return async id => {
		const file = await manager.getRepository(MiDriveFile).findOne({
			where: { id }, select: { uri: true, userHost: true, isLink: true, webpublicAccessKey: true, webpublicUrl: true, url: true, isSensitive: true, comment: true },
		});
		if (!file) {
			return null;
		}
		const { uri, userHost, isLink, webpublicAccessKey, webpublicUrl, url, isSensitive, comment } = file;
		return { uri, userHost, isLink, webpublicAccessKey, webpublicUrl, url, isSensitive, comment };
	};
}
