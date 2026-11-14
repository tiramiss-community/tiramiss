/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull } from 'typeorm';
import { MiNote, MiUser } from 'backend-upstream/entities';
import { publicationRow } from './local-featured.js';
import type { EntityManager } from 'typeorm';
import type { OutboxReader } from '../../modules/federation/public.js';
import type { Redis } from 'ioredis';

export function createOutboxReader(manager: EntityManager, redis: Pick<Redis, 'pipeline'>): OutboxReader {
	return {
		async readLocalUser(id) {
			const user = await manager.getRepository(MiUser).findOne({ where: { id, host: IsNull() }, select: { id: true, notesCount: true } });
			return user === null ? null : { id: user.id, notesCount: user.notesCount };
		},
		async readDbPage(userId, bounds, limit) {
			const query = manager.getRepository(MiNote).createQueryBuilder('note')
				.where('note.userId = :userId', { userId })
				.andWhere('note.visibility IN (:...visibilities)', { visibilities: ['public', 'home'] })
				.andWhere('note.localOnly = FALSE');
			if (bounds.sinceId) {
				query.andWhere('note.id > :sinceId', { sinceId: bounds.sinceId });
			}
			if (bounds.untilId) {
				query.andWhere('note.id < :untilId', { untilId: bounds.untilId });
			}
			return (await query.orderBy('note.id', bounds.sinceId && !bounds.untilId ? 'ASC' : 'DESC').limit(limit).getMany()).map(publicationRow);
		},
		async readTimelineIds(userId) {
			const pipeline = redis.pipeline();
			pipeline.lrange(`list:userTimeline:${userId}`, 0, -1);
			pipeline.lrange(`list:userTimelineWithReplies:${userId}`, 0, -1);
			const result = await pipeline.exec();
			if (result === null) {
				return [];
			}
			// Source command errors fail during list processing; they must never become an empty-cache DB read.
			return result.map(([error, value]) => {
				if (error) {
					throw error;
				}
				return value as string[];
			});
		},
		async readCandidates(ids) {
			if (ids.length === 0) {
				return [];
			}
			const notes = await manager.getRepository(MiNote).createQueryBuilder('note')
				.where('note.id IN (:...ids)', { ids })
				.innerJoinAndSelect('note.user', 'user')
				.leftJoinAndSelect('note.reply', 'reply')
				.leftJoinAndSelect('note.renote', 'renote')
				.leftJoinAndSelect('reply.user', 'replyUser')
				.leftJoinAndSelect('renote.user', 'renoteUser')
				.leftJoinAndSelect('note.channel', 'channel')
				.getMany();
			return notes.map(note => ({
				note: publicationRow(note), authorSuspended: note.user!.isSuspended,
				replyUserId: note.replyUserId, replyUserHost: note.replyUserHost, renoteUserId: note.renoteUserId,
				replyAuthorSuspended: note.reply?.user?.isSuspended ?? false,
				renoteAuthorSuspended: note.renote?.user?.isSuspended ?? false,
			}));
		},
	};
}
export function createLocalActivityReader(manager: EntityManager) {
	return async (id: string) => {
		const note = await manager.getRepository(MiNote).findOneBy({ id, userHost: IsNull(), visibility: In(['public', 'home']), localOnly: false });
		return note === null ? null : publicationRow(note);
	};
}
