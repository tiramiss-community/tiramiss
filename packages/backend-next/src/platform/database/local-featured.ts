/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull } from 'typeorm';
import { MiNote, MiUser, MiUserNotePining } from 'backend-upstream/entities';
import { createNoteActivityFactReader } from './note-activity.js';
import type { EntityManager } from 'typeorm';
import type { FeaturedReader, NotePublicationReader, NotePublicationRow } from '../../modules/federation/public.js';
import type { NoteMediaOptions } from './note-files.js';

function row(note: MiNote): NotePublicationRow {
	return {
		id: note.id, userId: note.userId, userHost: note.userHost, uri: note.uri, localOnly: note.localOnly,
		text: note.text, cw: note.cw, visibility: note.visibility, replyId: note.replyId, renoteId: note.renoteId,
		renoteUserHost: note.renoteUserHost, fileIds: note.fileIds, hasPoll: note.hasPoll, tags: note.tags,
		mentionedRemoteUsers: note.mentionedRemoteUsers, mentions: note.mentions, emojis: note.emojis,
	};
}

export function createNotePublicationReader(manager: EntityManager, options: Pick<NoteMediaOptions, 'url' | 'mediaProxy' | 'externalMediaProxyEnabled' | 'createdAtFromId'>): NotePublicationReader {
	const facts = createNoteActivityFactReader(manager, options);
	return {
		async readNote(id) {
			const note = await manager.getRepository(MiNote).findOneBy({ id });
			return note === null ? null : row(note);
		},
		authorExists: id => manager.getRepository(MiUser).existsBy({ id }),
		readMentionedUsers: facts.readMentionedUsers, readFiles: facts.readFileFacts,
		readPoll: id => facts.readPoll(id, true), readEmojis: facts.readEmojis,
	};
}
export function createFeaturedReader(manager: EntityManager): FeaturedReader {
	return {
		async readLocalUser(id) {
			const user = await manager.getRepository(MiUser).findOne({ where: { id, host: IsNull() }, select: { id: true } });
			return user === null ? null : { id: user.id };
		},
		async readPinNoteIdsDescending(userId) {
			return (await manager.getRepository(MiUserNotePining).find({ where: { userId }, order: { id: 'DESC' } })).map(pin => pin.noteId);
		},
		async readPinnedNote(id) {
			return row(await manager.getRepository(MiNote).findOneByOrFail({ id }));
		},
	};
}
export function createPublicNoteReader(manager: EntityManager) {
	return async (id: string): Promise<NotePublicationRow | null> => {
		const note = await manager.getRepository(MiNote).findOneBy({ id, visibility: In(['public', 'home']), localOnly: false });
		return note === null ? null : row(note);
	};
}
