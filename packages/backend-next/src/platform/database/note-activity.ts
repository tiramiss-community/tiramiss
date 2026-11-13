/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In } from 'typeorm';
import { MiDriveFile, MiNote, MiPoll, MiUser } from 'backend-upstream/entities';
import { createLocalEmojiReader } from './local-emojis.js';
import { readMeta } from './meta.js';
import { publicFileUrl } from './note-files.js';
import type { EntityManager } from 'typeorm';
import type { NoteActivityMaterials, NoteDeliveryMaterials, ApDocumentSourceFacts } from '../../modules/federation/public.js';
import type { MentionedRemoteUser } from '../../modules/mfm/public.js';
import type { NoteMediaOptions } from './note-files.js';

/**
 * 保存済みの投稿を AP 表現と配送の材料として読み直す。投稿が無ければ null。
 * 本家 ApRendererService.renderNote と同じく、返信先・引用先・メンション・添付・投票・絵文字は表現の時点の行を使う。
 */
export function createNoteActivityFactReader(manager: EntityManager, options: Pick<NoteMediaOptions, 'url' | 'mediaProxy' | 'externalMediaProxyEnabled' | 'createdAtFromId'>) {
	async function readReply(replyId: string | null): Promise<NoteActivityMaterials['reply']> {
		if (replyId === null) {
			return null;
		}
		const reply = await manager.getRepository(MiNote).findOne({ where: { id: replyId }, select: { id: true, uri: true, userId: true } });
		if (reply === null || !await manager.getRepository(MiUser).existsBy({ id: reply.userId })) {
			return null;
		}
		return { id: reply.id, uri: reply.uri };
	}

	async function readRenote(renoteId: string | null): Promise<NoteActivityMaterials['renote']> {
		if (renoteId === null) {
			return null;
		}
		return await manager.getRepository(MiNote).findOne({ where: { id: renoteId }, select: { id: true, uri: true } });
	}

	// 本家は findBy(In) の返却順を使うため順が決まらない。保存した mentions の順に並べ、毎回同じ本文にする。
	async function readMentionedUsers(ids: string[]): Promise<NoteActivityMaterials['mentionedUsers']> {
		if (ids.length === 0) {
			return [];
		}
		const users = await manager.getRepository(MiUser).find({ where: { id: In(ids) }, select: { id: true, username: true, host: true, uri: true } });
		return ids.flatMap(id => users.filter(user => user.id === id).map(user => ({ id: user.id, username: user.username, host: user.host, uri: user.uri })));
	}

	async function readFileFacts(ids: string[]): Promise<ApDocumentSourceFacts[]> {
		if (ids.length === 0) {
			return [];
		}
		const [files, meta] = await Promise.all([manager.getRepository(MiDriveFile).findBy({ id: In(ids) }), readMeta(manager)]);
		return ids.flatMap(id => files.filter(file => file.id === id).map(file => ({
			type: file.type,
			webpublicType: file.webpublicType,
			publicFile: { uri: file.uri, userHost: file.userHost, isLink: file.isLink, webpublicAccessKey: file.webpublicAccessKey, webpublicUrl: file.webpublicUrl, url: file.url },
			proxyRemoteFiles: meta.proxyRemoteFiles, urlOptions: options,
			comment: file.comment,
			width: file.properties?.width,
			height: file.properties?.height,
			isSensitive: file.isSensitive,
		})));
	}

	async function readFiles(ids: string[]): Promise<NoteActivityMaterials['files']> {
		return (await readFileFacts(ids)).map(({ publicFile, proxyRemoteFiles, urlOptions, ...file }) => ({ ...file, url: publicFileUrl(publicFile, proxyRemoteFiles, urlOptions) }));
	}

	async function readPoll(noteId: string, hasPoll: boolean): Promise<NoteActivityMaterials['poll']> {
		if (!hasPoll) {
			return null;
		}
		const poll = await manager.getRepository(MiPoll).findOneBy({ noteId });
		return poll && { choices: poll.choices, multiple: poll.multiple, votes: poll.votes, expiresAtMs: poll.expiresAt?.getTime() ?? null };
	}

	const readEmojis = createLocalEmojiReader(manager);

	return { readReply, readRenote, readMentionedUsers, readFiles, readFileFacts, readPoll, readEmojis };
}

export function createNoteActivityReader(manager: EntityManager, options: Pick<NoteMediaOptions, 'url' | 'mediaProxy' | 'externalMediaProxyEnabled' | 'createdAtFromId'>) {
	const { readReply, readRenote, readMentionedUsers, readFiles, readPoll, readEmojis } = createNoteActivityFactReader(manager, options);
	return async (noteId: string): Promise<NoteDeliveryMaterials | null> => {
		const note = await manager.getRepository(MiNote).findOneBy({ id: noteId });
		if (note === null) {
			return null;
		}

		const [reply, renote, mentionedUsers, files, poll, emojis] = await Promise.all([
			readReply(note.replyId),
			readRenote(note.renoteId),
			readMentionedUsers(note.mentions),
			readFiles(note.fileIds),
			readPoll(note.id, note.hasPoll),
			readEmojis(note.emojis),
		]);

		return {
			note: {
				id: note.id,
				userId: note.userId,
				createdAtMs: options.createdAtFromId(note.id),
				text: note.text,
				cw: note.cw,
				visibility: note.visibility,
				replyId: note.replyId,
				renoteId: note.renoteId,
				renoteUserHost: note.renoteUserHost,
				fileIds: note.fileIds,
				hasPoll: note.hasPoll,
				tags: note.tags,
				mentionedRemoteUsers: JSON.parse(note.mentionedRemoteUsers) as MentionedRemoteUser[],
			},
			reply, renote, mentionedUsers, files, poll, emojis,
			delivery: {
				userHost: note.userHost,
				localOnly: note.localOnly,
				mentions: note.mentions,
				replyUserId: note.replyUserId,
				replyUserHost: note.replyUserHost,
				renoteUserId: note.renoteUserId,
				renoteUserHost: note.renoteUserHost,
			},
		};
	};
}
