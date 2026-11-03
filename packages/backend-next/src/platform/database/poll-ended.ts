/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiNote, MiPollVote, MiUserProfile } from 'backend-upstream/entities';
import { DiagnosticError } from '../diagnostic-error.js';
import { PostNotificationPersistence } from './notification/persistence.js';
import { createTransactionRunner } from './transaction-runner.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { PollEndedNote, PollEndedRecipient, PostNotificationWrites } from '../../modules/notification/public.js';

export function createPollEndedReader(manager: EntityManager) {
	return {
		async readNote(id: string): Promise<PollEndedNote | null> {
			return manager.getRepository(MiNote).findOne({ where: { id }, select: { id: true, userId: true, hasPoll: true } });
		},

		// 本家と同じく並び順を指定しない。重複は呼び出し側でまとめる。
		async readLocalVoterIds(noteId: string): Promise<string[]> {
			const votes = await manager.getRepository(MiPollVote).createQueryBuilder('vote')
				.select('vote.userId')
				.innerJoin('vote.user', 'user')
				.where('vote.noteId = :noteId', { noteId })
				.andWhere('user.host IS NULL')
				.getMany();
			return votes.map(vote => vote.userId);
		},

		async readRecipient(userId: string): Promise<PollEndedRecipient> {
			const profile = await manager.getRepository(MiUserProfile).findOne({
				where: { userId }, select: { userId: true, userHost: true, notificationRecieveConfig: true },
			});
			if (profile === null) {
				throw new DiagnosticError('USER_PROFILE_NOT_FOUND', { userId });
			}
			// 本家は古いキャッシュに設定がない場合も考えて ?? {} で読む。
			return { userHost: profile.userHost, receiveConfig: (profile.notificationRecieveConfig ?? {}).pollEnded?.type ?? null };
		},
	};
}

export function createNotificationTransactions(source: DataSource) {
	const persistence = new PostNotificationPersistence();
	return createTransactionRunner<PostNotificationWrites>(source, manager => ({
		save: notification => persistence.save(manager, notification),
	}));
}
