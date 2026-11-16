/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiNote } from 'backend-upstream/entities';
import { readMeta } from './meta.js';
import { createNoteReader, noteFactsFromRow } from './note-reader.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import type { ActorEmojiCache } from '../actor-emoji-cache.js';
import type { NoteMediaOptions } from './note-files.js';
import type { NotesListReader } from '../../modules/note/public.js';

export function createNotesListReader(manager: EntityManager, redis: Redis, options: NoteMediaOptions, actorEmojis?: Pick<ActorEmojiCache, 'remote'>): NotesListReader {
	return { async readPage(input, pagination, guest) {
		const query = manager.getRepository(MiNote).createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser')
			.where('note.visibility = :visibility', { visibility: 'public' })
			.andWhere('note.localOnly = FALSE')
			.orderBy('note.id', pagination.order)
			.limit(input.limit);
		if (pagination.sinceId) {
			query.andWhere('note.id > :sinceId', { sinceId: pagination.sinceId });
		}
		if (pagination.untilId) {
			query.andWhere('note.id < :untilId', { untilId: pagination.untilId });
		}
		if (input.local) {
			query.andWhere('note.userHost IS NULL');
		}
		if (guest) {
			const meta = await readMeta(manager);
			if (meta.ugcVisibilityForVisitor === 'none') {
				query.andWhere('1=0');
			} else if (meta.ugcVisibilityForVisitor === 'local') {
				query.andWhere('note.userHost IS NULL');
			}
		}
		if (input.reply !== undefined) {
			query.andWhere(input.reply ? 'note.replyId IS NOT NULL' : 'note.replyId IS NULL');
		}
		if (input.renote !== undefined) {
			query.andWhere(input.renote ? 'note.renoteId IS NOT NULL' : 'note.renoteId IS NULL');
		}
		if (input.withFiles !== undefined) {
			query.andWhere(input.withFiles ? "note.fileIds != '{}'" : "note.fileIds = '{}'");
		}
		if (input.poll !== undefined) {
			query.andWhere(input.poll ? 'note.hasPoll = TRUE' : 'note.hasPoll = FALSE');
		}
		const rows = await query.getMany();
		const roots = rows.map(note => noteFactsFromRow(note, options.createdAtFromId));
		const selected = new Map(roots.map(note => [note.id, note]));
		const absent = new Set<string>();
		for (const row of rows) {
			for (const [id, related] of [[row.replyId, row.reply], [row.renoteId, row.renote]] as const) {
				if (related) {
					selected.set(related.id, noteFactsFromRow(related, options.createdAtFromId));
				} else if (id) {
					absent.add(id);
				}
			}
		}
		const selectedUsers = [...new Map(rows.flatMap(row => [row.user, row.reply?.user, row.renote?.user].flatMap(user => user ? [[user.id, user] as const] : []))).values()];
		// packMany appends ID-loaded reference authors after joined root authors.
		const refreshUserIds = rows.flatMap(row => [row.replyUserId, row.renoteUserId].filter((id): id is string => id !== null));
		const reader = createNoteReader(manager, redis, options, actorEmojis, selectedUsers, refreshUserIds);
		return { roots, reader: {
			readMaterials: reader.readMaterials,
			async readNotes(ids) {
				const missing = ids.filter(id => !selected.has(id) && !absent.has(id));
				return [
					...ids.flatMap(id => selected.has(id) ? [selected.get(id)!] : []),
					...(missing.length ? await reader.readNotes(missing) : []),
				];
			},
		} };
	} };
}
