/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { settleAll } from '../settle-all.js';
import { MiBlocking, MiChannelFollowing, MiChannelMuting, MiFollowing, MiMuting, MiNoteReaction, MiRenoteMuting, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { emptyStreamFacts } from '../../modules/stream/public.js';
import { readNotePlan, renderNote } from '../../modules/note/public.js';
import { normalizeReaction } from '../../modules/note/public.js';
import { createTokenAuthenticator } from './authenticate.js';
import { createNoteReader } from './note-reader.js';
import { readMeta } from './meta.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger.js';
import type { NoteMediaOptions } from './note-files.js';
import type { StreamFacts, StreamNote } from '../../modules/stream/public.js';

export function createStreamingReader(manager: EntityManager, redis: Redis, logger: Logger, options: NoteMediaOptions) {
	const authenticate = createTokenAuthenticator(manager, logger);
	const reader = createNoteReader(manager, redis, options);
	return {
		authenticate: async (token: string | null) => token == null ? null : authenticate(token),
		async readFacts(userId: string | null): Promise<StreamFacts> {
			const facts = emptyStreamFacts(userId);
			facts.ugcVisibilityForVisitor = (await readMeta(manager)).ugcVisibilityForVisitor;
			if (userId === null) {
				return facts;
			}
			const [profile, following, channels, mutedChannels, muted, blocked, renoteMuted] = await settleAll([
				manager.getRepository(MiUserProfile).findOneByOrFail({ userId }),
				manager.getRepository(MiFollowing).findBy({ followerId: userId }),
				manager.getRepository(MiChannelFollowing).findBy({ followerId: userId }),
				manager.getRepository(MiChannelMuting).findBy({ userId }),
				manager.getRepository(MiMuting).findBy({ muterId: userId }),
				manager.getRepository(MiBlocking).findBy({ blockeeId: userId }),
				manager.getRepository(MiRenoteMuting).findBy({ muterId: userId }),
			]);
			return { ...facts, following: new Map(following.map(f => [f.followeeId, { withReplies: f.withReplies }])),
				followingChannels: new Set(channels.map(c => c.followeeId)), mutedChannels: new Set(mutedChannels.map(c => c.channelId)),
				mutedUsers: new Set(muted.map(m => m.muteeId)), blockingUsers: new Set(blocked.map(b => b.blockerId)),
				renoteMutedUsers: new Set(renoteMuted.map(m => m.muteeId)), mutedInstances: new Set(profile.mutedInstances) };
		},
		async hidingFollowing(userId: string | null): Promise<ReadonlySet<string>> {
			return new Set(userId ? (await manager.getRepository(MiFollowing).findBy({ followerId: userId })).map(f => f.followeeId) : []);
		},
		async repack(id: string, userId: string | null) {
			const notes = await readNotePlan([id], reader.readNotes);
			if (!notes.has(id)) {
				return null;
			}
			const now = Date.now();
			return renderNote(id, await reader.readMaterials(notes, userId, now), userId, now);
		},
		async reaction(note: StreamNote, userId: string | null): Promise<string | undefined> {
			if (!userId) {
				return undefined;
			}
			const count = Object.values(note.reactions ?? {}).reduce((sum, n) => sum + n, 0);
			if (!count) {
				return undefined;
			}
			const pairs = note.reactionAndUserPairCache;
			if (Array.isArray(pairs) && count <= pairs.length) {
				const pair = pairs.find((value: unknown) => typeof value === 'string' && value.startsWith(userId)) as string | undefined;
				return pair ? normalizeReaction(pair.split('/')[1]) : undefined;
			}
			if (options.createdAtFromId(note.id) + 2000 > Date.now()) {
				return undefined;
			}
			const reaction = await manager.getRepository(MiNoteReaction).findOneBy({ noteId: note.id, userId });
			return reaction ? normalizeReaction(reaction.reaction) : undefined;
		},
		async touchActivity(userId: string) {
			const user = await manager.getRepository(MiUser).findOneByOrFail({ id: userId });
			await manager.getRepository(MiUser).update(userId, { lastActiveDate: new Date() });
			if (user.isHibernated) {
				await settleAll([
					manager.getRepository(MiUser).update(userId, { isHibernated: false }),
					manager.getRepository(MiFollowing).update({ followerId: userId }, { isFollowerHibernated: false }),
				]);
			}
		},
	};
}
