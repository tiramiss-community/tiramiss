/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In } from 'typeorm';
import { MiUser, MiNote, MiPoll, MiDriveFile, MiBlocking, MiFollowing, MiChannel, MiUserProfile } from 'backend-upstream/entities';
import { evaluatePolicies, selectApplicableRoles } from '../../modules/role/public.js';
import { readMeta } from './meta.js';
import { createTransactionRunner } from './transaction-runner.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { TransactionRunner } from '../../application/transaction.js';
import type { MentionedRemoteUser, NewNote, NewPoll, NoteAttachableFile, NoteCreateAuthor, NoteWrites, RelatedChannel, RelatedNote } from '../../modules/note/public.js';
import type { RoleMaterialReader } from '../role-material-cache.js';

export function createNoteWriter(manager: EntityManager, roles: RoleMaterialReader, createdAtFromId: (id: string) => number) {
	return {
		async readAuthor(id: string, now: number): Promise<NoteCreateAuthor | null> {
			const user = await manager.getRepository(MiUser).findOneBy({ id });
			if (!user || user.host !== null) {
				return null;
			}
			const [meta, definitions, assignments] = await Promise.all([
				readMeta(manager), roles.readRoles(), roles.readAssignments(id),
			]);
			const applicable = selectApplicableRoles(definitions, assignments, {
				userId: id, host: user.host, createdAtMs: createdAtFromId(id), isSuspended: user.isSuspended,
				isLocked: user.isLocked, isBot: user.isBot, isCat: user.isCat, isExplorable: user.isExplorable,
				followersCount: user.followersCount, followingCount: user.followingCount, notesCount: user.notesCount,
			}, now);
			const policies = evaluatePolicies({ userId: id, roles: applicable, basePolicies: meta.policies, uploadLimitBytes: 0 });
			return { id, host: user.host, isSuspended: user.isSuspended, movedToUri: user.movedToUri, isBot: user.isBot, canPublicNote: policies.canPublicNote,
				mentionLimit: policies.mentionLimit, rateLimitFactor: policies.rateLimitFactor, sensitiveWords: meta.sensitiveWords, prohibitedWords: meta.prohibitedWords };
		},
		async readOwnedFiles(userId: string, fileIds: string[]): Promise<NoteAttachableFile[]> {
			// 本家と同じく所有者と ID だけで絞る。ID の生成順ではなく指定順で返すため array_position で並べる。
			const files = await manager.getRepository(MiDriveFile).createQueryBuilder('file')
				.select(['file.id', 'file.type'])
				.where('file.userId = :userId AND file.id IN (:...fileIds)', { userId, fileIds })
				.orderBy('array_position(ARRAY[:...fileIds], "file"."id"::text)')
				.getMany();
			return files.map(file => ({ id: file.id, type: file.type }));
		},
		async readNote(id: string): Promise<RelatedNote | null> {
			const row = await manager.getRepository(MiNote).findOne({ where: { id }, select: {
				id: true, userId: true, userHost: true, text: true, cw: true, fileIds: true, hasPoll: true, replyId: true, renoteId: true,
				threadId: true, channelId: true, visibility: true, visibleUserIds: true, mentions: true, replyUserId: true, localOnly: true,
			} });
			if (!row) {
				return null;
			}
			const { userId, userHost, text, cw, fileIds, hasPoll, replyId, renoteId, threadId, channelId, visibility, visibleUserIds, mentions, replyUserId, localOnly } = row;
			return { id, userId, userHost, text, cw, fileIds, hasPoll, replyId, renoteId, threadId, channelId, visibility, visibleUserIds, mentions, replyUserId, localOnly };
		},
		isBlocking(blockerId: string, blockeeId: string): Promise<boolean> {
			return manager.getRepository(MiBlocking).existsBy({ blockerId, blockeeId });
		},
		isFollowing(followerId: string, followeeId: string): Promise<boolean> {
			return manager.getRepository(MiFollowing).existsBy({ followerId, followeeId });
		},
		async readChannel(id: string, options: { includeArchived: boolean }): Promise<RelatedChannel | null> {
			const channel = await manager.getRepository(MiChannel).findOneBy(options.includeArchived ? { id } : { id, isArchived: false });
			return channel && { id: channel.id, allowRenoteToExternal: channel.allowRenoteToExternal };
		},
		async readMentionedRemoteUsers(userIds: string[]): Promise<MentionedRemoteUser[]> {
			const users = await manager.getRepository(MiUser).find({ where: { id: In(userIds) }, select: { id: true, username: true, host: true, uri: true } });
			const remotes = userIds.flatMap(id => users.filter(user => user.id === id && user.host !== null));
			if (remotes.length === 0) {
				return [];
			}
			const profiles = await manager.getRepository(MiUserProfile).find({ where: { userId: In(remotes.map(user => user.id)) }, select: { userId: true, url: true } });
			return remotes.map(user => {
				const url = profiles.find(profile => profile.userId === user.id)?.url ?? null;
				return { uri: user.uri!, ...(url === null ? {} : { url }), username: user.username, host: user.host! };
			});
		},
		writes: createNoteWrites(manager),
	};
}

function createNoteWrites(manager: EntityManager, assertActive: () => void = () => {}): NoteWrites {
	return {
		async insertNote({ mentionedRemoteUsers, ...note }: NewNote): Promise<void> {
			assertActive();
			await manager.getRepository(MiNote).insert({ ...note, mentionedRemoteUsers: JSON.stringify(mentionedRemoteUsers) });
		},
		async insertPoll({ expiresAtMs, ...poll }: NewPoll): Promise<void> {
			assertActive();
			await manager.getRepository(MiPoll).insert({ ...poll, expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs) });
		},
	};
}

export function createNoteWriteTransactions(source: DataSource): TransactionRunner<NoteWrites> {
	const transactions = createTransactionRunner(source, manager => manager);
	return {
		run: work => transactions.run(async manager => {
			let active = true;
			try {
				return await work(createNoteWrites(manager, () => {
					if (!active) {
						throw new Error('The note write transaction has ended');
					}
				}));
			} finally {
				active = false;
			}
		}),
	};
}
