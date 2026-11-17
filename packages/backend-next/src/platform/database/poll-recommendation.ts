/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Brackets, In } from 'typeorm';
import { MiMuting, MiNote, MiPoll, MiPollVote, MiUser } from 'backend-upstream/entities';
import { createNoteReader, noteFactsFromRow } from './note-reader.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import type { ActorEmojiCache } from '../actor-emoji-cache.js';
import type { NoteMediaOptions } from './note-files.js';
import type { PollRecommendationReader } from '../../modules/poll-recommendation/public.js';

export function createPollRecommendationReader(manager: EntityManager, redis: Redis, options: NoteMediaOptions, actorEmojis?: Pick<ActorEmojiCache, 'remote'>): PollRecommendationReader {
	const reader = createNoteReader(manager, redis, options, actorEmojis);
	return {
		async readAccessFacts(userId) {
			const user = await manager.getRepository(MiUser).findOneByOrFail({ id: userId });
			return { isSuspended: user.isSuspended, isModerator: false, isAdministrator: false };
		},
		async readPage(input, viewerId, now) {
			const votes = manager.getRepository(MiPollVote).createQueryBuilder('vote')
				.select('vote.noteId').where('vote.userId = :meId', { meId: viewerId });
			const mutings = manager.getRepository(MiMuting).createQueryBuilder('muting')
				.select('muting.muteeId').where('muting.muterId = :muterId', { muterId: viewerId });
			const query = manager.getRepository(MiPoll).createQueryBuilder('poll')
				.where('poll.userHost IS NULL')
				.andWhere('poll.userId != :meId', { meId: viewerId })
				.andWhere('poll.noteVisibility = :visibility', { visibility: 'public' })
				.andWhere(new Brackets(qb => qb.where('poll.expiresAt IS NULL').orWhere('poll.expiresAt > :now', { now: new Date(now) })))
				.andWhere(`poll.noteId NOT IN (${votes.getQuery()})`).setParameters(votes.getParameters())
				.andWhere(`poll.userId NOT IN (${mutings.getQuery()})`).setParameters(mutings.getParameters());
			if (input.excludeChannels) {
				query.andWhere('poll.channelId IS NULL');
			}
			const polls = await query.orderBy('poll.noteId', 'DESC').limit(input.limit).offset(input.offset).getMany();
			// The endpoint refetches Notes after selecting Polls, without timeline filters or joined author snapshots.
			const rows = polls.length ? await manager.getRepository(MiNote).find({ where: { id: In(polls.map(poll => poll.noteId)) }, order: { id: 'DESC' } }) : [];
			return { roots: rows.map(row => noteFactsFromRow(row, options.createdAtFromId)), reader };
		},
	};
}
