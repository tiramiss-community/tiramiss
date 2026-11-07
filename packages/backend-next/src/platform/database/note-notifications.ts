/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull } from 'typeorm';
import { MiFollowing, MiMuting, MiNote, MiNoteThreadMuting, MiRenoteMuting, MiUser, MiUserListMembership, MiUserProfile } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { NoteCreatedSnapshot, NoteNotificationPlanInput } from '../../modules/note/public.js';
import type { NotificationReception, PostNotificationType } from '../../modules/notification/public.js';

export function createNoteNotificationReader(manager: EntityManager) {
	return {
		async read(noteId: string, snapshot?: NoteCreatedSnapshot): Promise<NoteNotificationPlanInput | null> {
			const note = snapshot?.note ?? await manager.getRepository(MiNote).findOneBy({ id: noteId });
			if (note === null) {
				return null;
			}
			const reply = snapshot?.reply ?? (note.replyId === null ? null : await manager.getRepository(MiNote).findOneBy({ id: note.replyId }));
			const candidateIds = [...new Set([...note.mentions, ...(note.replyUserId ? [note.replyUserId] : []), ...(note.renoteUserId ? [note.renoteUserId] : [])])];
			const local = candidateIds.length > 0 ? await manager.getRepository(MiUser).find({ where: { id: In(candidateIds), host: IsNull() }, select: { id: true } }) : [];
			return {
				id: note.id, userId: note.userId, channelId: note.channelId, visibility: note.visibility, visibleUserIds: note.visibleUserIds, mentions: note.mentions, threadId: note.threadId ?? note.id, replyThreadId: reply?.threadId ?? note.threadId ?? note.replyId ?? undefined,
				reply: note.replyId === null ? null : { id: note.replyId, userId: note.replyUserId! }, renote: note.renoteId === null ? null : { id: note.renoteId, userId: note.renoteUserId! },
				pureRenote: note.renoteId !== null && note.text === null && note.cw === null && note.replyId === null && !note.hasPoll && note.fileIds.length === 0,
				localUserIds: new Set(local.map(u => u.id)), threadMutedUserIds: new Set<string>(),
				subscribers: [],
			};
		},
		async readSubscribers(note: NoteNotificationPlanInput) {
			if (note.reply !== null || note.visibility === 'specified') {
				return [];
			}
			const subscribers = await manager.getRepository(MiFollowing).findBy({ followeeId: note.userId, notify: 'normal' });
			const mutings = note.pureRenote && subscribers.length > 0
				? await manager.getRepository(MiRenoteMuting).findBy({ muterId: In(subscribers.map(s => s.followerId)), muteeId: note.userId }) : [];
			const renoteMutedUserIds = new Set(mutings.map(m => m.muterId));
			return subscribers.map(s => ({ userId: s.followerId, renoteMuted: renoteMutedUserIds.has(s.followerId) }));
		},
		async isThreadMuted(userId: string, threadId: string): Promise<boolean> {
			return manager.getRepository(MiNoteThreadMuting).existsBy({ userId, threadId });
		},
		async readReception(recipientId: string, notifierId: string, type: PostNotificationType): Promise<NotificationReception> {
			const profile = await manager.getRepository(MiUserProfile).findOneByOrFail({ userId: recipientId });
			const config = (profile.notificationRecieveConfig ?? {})[type];
			const [muted, followsNotifier, followedByNotifier, listContainsNotifier] = await Promise.all([
				manager.getRepository(MiMuting).existsBy({ muterId: recipientId, muteeId: notifierId }),
				manager.getRepository(MiFollowing).existsBy({ followerId: recipientId, followeeId: notifierId }),
				manager.getRepository(MiFollowing).existsBy({ followerId: notifierId, followeeId: recipientId }),
				config?.type === 'list' ? manager.getRepository(MiUserListMembership).existsBy({ userListId: config.userListId, userId: notifierId }) : false,
			]);
			return { recipientId, notifierId, mode: config?.type ?? null, muted, followsNotifier, followedByNotifier, listContainsNotifier };
		},
		async canPublish(recipientId: string, notifierId: string | null): Promise<boolean> {
			if (notifierId === null) {
				return true;
			}
			const [user, profile, muted] = await Promise.all([
				manager.getRepository(MiUser).findOneBy({ id: notifierId }),
				manager.getRepository(MiUserProfile).findOneByOrFail({ userId: recipientId }),
				manager.getRepository(MiMuting).existsBy({ muterId: recipientId, muteeId: notifierId }),
			]);
			return user !== null && !user.isSuspended && !muted && !(user.host !== null && profile.mutedInstances.includes(user.host));
		},
	};
}
