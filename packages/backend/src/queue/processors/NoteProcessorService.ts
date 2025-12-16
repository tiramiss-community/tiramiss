/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { In, IsNull, LessThan } from 'typeorm';
import * as Redis from 'ioredis';
import { NoteNotificationManagerService } from '@/core/NoteNotificationManagerService.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type {
	ChannelFollowingsRepository,
	ChannelsRepository,
	FollowingsRepository,
	InstancesRepository,
	MutingsRepository,
	NoteThreadMutingsRepository,
	NotesRepository,
	PollsRepository,
	UserListMembershipsRepository,
	UsersRepository,
} from '@/models/_.js';
import { MiNote } from '@/models/Note.js';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { MiChannel } from '@/models/Channel.js';
import type { MiMeta } from '@/models/Meta.js';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { UserWebhookService } from '@/core/UserWebhookService.js';
import { HashtagService } from '@/core/HashtagService.js';
import { AntennaService } from '@/core/AntennaService.js';
import { QueueService } from '@/core/QueueService.js';
import { SearchService } from '@/core/SearchService.js';
import { RelayService } from '@/core/RelayService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import NotesChart from '@/core/chart/charts/notes.js';
import PerUserNotesChart from '@/core/chart/charts/per-user-notes.js';
import ActiveUsersChart from '@/core/chart/charts/active-users.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { CacheService } from '@/core/CacheService.js';
import { bindThis } from '@/decorators.js';
import { isRenote, isQuote } from '@/misc/is-renote.js';
import { isReply } from '@/misc/is-reply.js';
import { IdService } from '@/core/IdService.js';
import type { NotePostJobData } from '@/queue/types.js';
import type Logger from '@/logger.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';

@Injectable()
export class NoteProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.noteThreadMutingsRepository)
		private noteThreadMutingsRepository: NoteThreadMutingsRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		@Inject(DI.channelFollowingsRepository)
		private channelFollowingsRepository: ChannelFollowingsRepository,

		@Inject(DI.channelsRepository)
		private channelsRepository: ChannelsRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private idService: IdService,
		private userEntityService: UserEntityService,
		private noteEntityService: NoteEntityService,
		private fanoutTimelineService: FanoutTimelineService,
		private notificationService: NotificationService,
		private noteNotificationManagerService: NoteNotificationManagerService,
		private webhookService: UserWebhookService,
		private hashtagService: HashtagService,
		private antennaService: AntennaService,
		private queueService: QueueService,
		private searchService: SearchService,
		private relayService: RelayService,
		private federatedInstanceService: FederatedInstanceService,
		private apDeliverManagerService: ApDeliverManagerService,
		private apRendererService: ApRendererService,
		private featuredService: FeaturedService,
		private notesChart: NotesChart,
		private perUserNotesChart: PerUserNotesChart,
		private activeUsersChart: ActiveUsersChart,
		private instanceChart: InstanceChart,
		private cacheService: CacheService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('note-post');
	}

	@bindThis
	public async process(job: Bull.Job<NotePostJobData>): Promise<void> {
		const { noteId, silent } = job.data;

		const note = await this.notesRepository.findOneBy({ id: noteId });
		if (note == null) {
			this.logger.debug(`note ${noteId} already deleted; skipping`);
			return;
		}
		const user = await this.usersRepository.findOneBy({ id: note.userId });
		if (user == null) {
			this.logger.debug(`user ${note.userId} already deleted; skipping`);
			return;
		}

		const results = await Promise.allSettled([
			this.runRealtime(note),
			this.runNotifications(note, user, silent),
			this.runBackgroundWork(note, user, silent),
		]);

		for (const result of results) {
			if (result.status === 'rejected') {
				this.logger.warn('notePost subtask failed', { error: result.reason instanceof Error ? { name: result.reason.name, message: result.reason.message, stack: result.reason.stack } : String(result.reason) });
			}
		}
	}

	@bindThis
	private async runRealtime(note: MiNote): Promise<void> {
		await this.pushToTl(note);
	}

	@bindThis
	private async runNotifications(note: MiNote, user: MiUser, silent: boolean): Promise<void> {
		if (silent) return;

		const noteObj = await this.noteEntityService.pack(note, null, { skipHide: true, withReactionAndUserPairCache: true });

		if (this.userEntityService.isLocalUser(user)) {
			this.activeUsersChart.write(user as MiLocalUser);
		}

		this.webhookService.enqueueUserWebhook(user.id, 'note', { note: noteObj });

		const nm = this.noteNotificationManagerService.create(user, note);

		if (note.replyId) {
			if (note.replyUserHost === null) {
				const threadId = note.threadId ?? note.replyId;
				const isThreadMuted = await this.noteThreadMutingsRepository.exists({
					where: {
						userId: note.replyUserId!,
						threadId,
					},
				});

				if (!isThreadMuted) {
					nm.push(note.replyUserId as MiLocalUser['id'], 'reply');
					this.webhookService.enqueueUserWebhook(note.replyUserId!, 'reply', { note: noteObj });
				}
			}
		}

		if (isRenote(note)) {
			const type = isQuote(note) ? 'quote' : 'renote';

			if (note.renoteUserHost === null) {
				nm.push(note.renoteUserId as MiLocalUser['id'], type);
			}

			if ((user.id !== note.renoteUserId) && note.renoteUserHost === null) {
				this.webhookService.enqueueUserWebhook(note.renoteUserId!, 'renote', { note: noteObj });
			}
		}

		const mentionedUsers = await this.fetchMentionedUsers(note);
		await this.createMentionedEvents(mentionedUsers, note, nm);

		nm.notify();

		if (!note.replyId) {
			this.followingsRepository.findBy({
				followeeId: user.id,
				notify: 'normal',
			}).then(async followings => {
				if (note.visibility !== 'specified') {
					const isPureRenote = isRenote(note) && !isQuote(note);
					for (const following of followings) {
						let isRenoteMuted = false;
						if (isPureRenote) {
							const userIdsWhoMeMutingRenotes = await this.cacheService.renoteMutingsCache.fetch(following.followerId);
							isRenoteMuted = userIdsWhoMeMutingRenotes.has(user.id);
						}
						if (!isRenoteMuted) {
							this.notificationService.createNotification(following.followerId, 'note', {
								noteId: note.id,
							}, user.id);
						}
					}
				}
			});
		}
	}

	@bindThis
	private async runBackgroundWork(note: MiNote, user: MiUser, silent: boolean): Promise<void> {
		if (note.visibility === 'public' || note.visibility === 'home') {
			this.hashtagService.updateHashtags(user, note.tags ?? []);
		}

		this.queueService.updateUserNotesCount(user.id);

		const channel = note.channelId
			? await this.channelsRepository.findOneBy({ id: note.channelId })
			: null;

		this.antennaService.addNoteToAntennas({
			...note,
			channel: channel ?? null,
		} as MiNote & { channel: MiChannel | null }, user);

		if (note.replyId) {
			this.notesRepository.increment({ id: note.replyId }, 'repliesCount', 1);
		}

		if (note.hasPoll) {
			const poll = await this.pollsRepository.findOneBy({ noteId: note.id });
			if (poll?.expiresAt) {
				const delay = poll.expiresAt.getTime() - Date.now();
				this.queueService.endedPollNotification(note.id, delay);
			}
		}

		if (note.channelId) {
			this.channelsRepository.increment({ id: note.channelId }, 'notesCount', 1);
			this.channelsRepository.update(note.channelId, { lastNotedAt: new Date() });

			this.notesRepository.countBy({
				userId: user.id,
				channelId: note.channelId,
			}).then(count => {
				if (count === 1) {
					this.channelsRepository.increment({ id: note.channelId! }, 'usersCount', 1);
				}
			});
		}

		this.notesChart.update(note, true);
		if (note.visibility !== 'specified' && (this.meta.enableChartsForRemoteUser || (user.host == null))) {
			this.perUserNotesChart.update(user, note, true);
		}

		if (this.meta.enableStatsForFederatedInstances && this.userEntityService.isRemoteUser(user)) {
			this.federatedInstanceService.fetchOrRegister(user.host).then(async i => {
				await this.instancesRepository.increment({ id: i.id }, 'notesCount', 1);
				if (this.meta.enableChartsForFederatedInstances) {
					this.instanceChart.updateNote(i.host, note, true);
				}
			});
		}

		if (isRenote(note) && note.renoteUserId !== user.id && !user.isBot) {
			const renoteTarget = await this.notesRepository.findOneByOrFail({ id: note.renoteId });
			this.incRenoteCount(renoteTarget);
		}

		this.index(note);

		if (!silent) {
			await this.deliverActivity(note, user);
		}
	}

	@bindThis
	private async fetchMentionedUsers(note: MiNote): Promise<MiUser[]> {
		if (!note.mentions || note.mentions.length === 0) return [];
		return await this.usersRepository.findBy({ id: In(note.mentions) });
	}

	@bindThis
	private async pushToTl(note: MiNote) {
		if (!this.meta.enableFanoutTimeline) return;

		const r = this.redisForTimelines.pipeline();

		if (note.channelId) {
			this.fanoutTimelineService.push(`channelTimeline:${note.channelId}`, note.id, this.config.perChannelMaxNoteCacheCount, r);

			this.fanoutTimelineService.push(`userTimelineWithChannel:${note.userId}`, note.id, note.userHost == null ? this.meta.perLocalUserUserTimelineCacheMax : this.meta.perRemoteUserUserTimelineCacheMax, r);

			const channelFollowings = await this.channelFollowingsRepository.find({
				where: {
					followeeId: note.channelId,
				},
				select: ['followerId'],
			});

			for (const channelFollowing of channelFollowings) {
				this.fanoutTimelineService.push(`homeTimeline:${channelFollowing.followerId}`, note.id, this.meta.perUserHomeTimelineCacheMax, r);
				if (note.fileIds.length > 0) {
					this.fanoutTimelineService.push(`homeTimelineWithFiles:${channelFollowing.followerId}`, note.id, this.meta.perUserHomeTimelineCacheMax / 2, r);
				}
			}
		} else {
			const [followings, fetchedUserListMemberships] = await Promise.all([
				this.followingsRepository.find({
					where: {
						followeeId: note.userId,
						followerHost: IsNull(),
						isFollowerHibernated: false,
					},
					select: ['followerId', 'withReplies'],
				}),
				this.userListMembershipsRepository.find({
					where: {
						userId: note.userId,
					},
					select: ['userListId', 'userListUserId', 'withReplies'],
				}),
			]);
			let userListMemberships = fetchedUserListMemberships;

			if (note.visibility === 'followers') {
				userListMemberships = userListMemberships.filter(x => x.userListUserId === note.userId || followings.some(f => f.followerId === x.userListUserId));
			}

			for (const following of followings) {
				if (note.visibility === 'specified' && !note.visibleUserIds.some(v => v === following.followerId)) continue;

				if (isReply(note, following.followerId)) {
					if (!following.withReplies) continue;
				}

				this.fanoutTimelineService.push(`homeTimeline:${following.followerId}`, note.id, this.meta.perUserHomeTimelineCacheMax, r);
				if (note.fileIds.length > 0) {
					this.fanoutTimelineService.push(`homeTimelineWithFiles:${following.followerId}`, note.id, this.meta.perUserHomeTimelineCacheMax / 2, r);
				}
			}

			for (const userListMembership of userListMemberships) {
				if (
					note.visibility === 'specified' &&
					note.userId !== userListMembership.userListUserId &&
					!note.visibleUserIds.some(v => v === userListMembership.userListUserId)
				) continue;

				if (isReply(note, userListMembership.userListUserId)) {
					if (!userListMembership.withReplies) continue;
				}

				this.fanoutTimelineService.push(`userListTimeline:${userListMembership.userListId}`, note.id, this.meta.perUserListTimelineCacheMax, r);
				if (note.fileIds.length > 0) {
					this.fanoutTimelineService.push(`userListTimelineWithFiles:${userListMembership.userListId}`, note.id, this.meta.perUserListTimelineCacheMax / 2, r);
				}
			}

			if (note.userHost == null) {
				if (note.visibility !== 'specified' || !note.visibleUserIds.some(v => v === note.userId)) {
					this.fanoutTimelineService.push(`homeTimeline:${note.userId}`, note.id, this.meta.perUserHomeTimelineCacheMax, r);
					if (note.fileIds.length > 0) {
						this.fanoutTimelineService.push(`homeTimelineWithFiles:${note.userId}`, note.id, this.meta.perUserHomeTimelineCacheMax / 2, r);
					}
				}
			}

			if (isReply(note)) {
				this.fanoutTimelineService.push(`userTimelineWithReplies:${note.userId}`, note.id, note.userHost == null ? this.meta.perLocalUserUserTimelineCacheMax : this.meta.perRemoteUserUserTimelineCacheMax, r);

				if (note.visibility === 'public' && note.userHost == null) {
					this.fanoutTimelineService.push('localTimelineWithReplies', note.id, 300, r);
					if (note.replyUserHost == null) {
						this.fanoutTimelineService.push(`localTimelineWithReplyTo:${note.replyUserId}`, note.id, 300 / 10, r);
					}
				}
			} else {
				this.fanoutTimelineService.push(`userTimeline:${note.userId}`, note.id, note.userHost == null ? this.meta.perLocalUserUserTimelineCacheMax : this.meta.perRemoteUserUserTimelineCacheMax, r);
				if (note.fileIds.length > 0) {
					this.fanoutTimelineService.push(`userTimelineWithFiles:${note.userId}`, note.id, note.userHost == null ? this.meta.perLocalUserUserTimelineCacheMax / 2 : this.meta.perRemoteUserUserTimelineCacheMax / 2, r);
				}

				if (note.visibility === 'public' && note.userHost == null) {
					this.fanoutTimelineService.push('localTimeline', note.id, 1000, r);
					if (note.fileIds.length > 0) {
						this.fanoutTimelineService.push('localTimelineWithFiles', note.id, 500, r);
					}
				}
			}

			if (Math.random() < 0.1) {
				process.nextTick(() => {
					this.checkHibernation(followings);
				});
			}
		}

		r.exec();
	}

	@bindThis
	private async checkHibernation(followings: { followerId: string }[]) {
		if (followings.length === 0) return;

		const shuffle = (array: { followerId: string }[]) => {
			for (let i = array.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[array[i], array[j]] = [array[j], array[i]];
			}
			return array;
		};

		const samples = shuffle(followings).slice(0, Math.min(followings.length, 1000));

		const hibernatedUsers = await this.usersRepository.find({
			where: {
				id: In(samples.map(x => x.followerId)),
				lastActiveDate: LessThan(new Date(Date.now() - (1000 * 60 * 60 * 24 * 50))),
			},
			select: ['id'],
		});

		if (hibernatedUsers.length > 0) {
			this.usersRepository.update({
				id: In(hibernatedUsers.map(x => x.id)),
			}, {
				isHibernated: true,
			});

			this.followingsRepository.update({
				followerId: In(hibernatedUsers.map(x => x.id)),
			}, {
				isFollowerHibernated: true,
			});
		}
	}

	@bindThis
	private async createMentionedEvents(mentionedUsers: MiUser[], note: MiNote, nm: ReturnType<NoteNotificationManagerService['create']>) {
		const localMentionedUsers = mentionedUsers.filter(u => this.userEntityService.isLocalUser(u));
		if (localMentionedUsers.length === 0) return;

		const threadId = note.threadId ?? note.id;
		const localMentionedUserIds = localMentionedUsers.map(u => u.id);

		const muted = await this.noteThreadMutingsRepository.find({
			where: {
				threadId,
				userId: In(localMentionedUserIds),
			},
			select: ['userId'],
		});
		const mutedUserIds = new Set(muted.map(x => x.userId));

		for (const u of localMentionedUsers) {
			if (mutedUserIds.has(u.id)) continue;

			const detailPackedNote = await this.noteEntityService.pack(note, u, {
				detail: true,
			});

			this.webhookService.enqueueUserWebhook(u.id, 'mention', { note: detailPackedNote });

			nm.push(u.id, 'mention');
		}
	}

	@bindThis
	private incRenoteCount(renote: MiNote) {
		this.notesRepository.createQueryBuilder().update()
			.set({
				renoteCount: () => '"renoteCount" + 1',
			})
			.where('id = :id', { id: renote.id })
			.execute();

		if (Math.random() < 0.3 && (Date.now() - this.idService.parse(renote.id).date.getTime()) < 1000 * 60 * 60 * 24 * 3) {
			if (renote.channelId != null) {
				if (renote.replyId == null) {
					this.featuredService.updateInChannelNotesRanking(renote.channelId, renote.id, 5);
				}
			} else {
				if (renote.visibility === 'public' && renote.userHost == null && renote.replyId == null) {
					this.featuredService.updateGlobalNotesRanking(renote.id, 5);
					this.featuredService.updatePerUserNotesRanking(renote.userId, renote.id, 5);
				}
			}
		}
	}

	@bindThis
	private index(note: MiNote) {
		if (note.text == null && note.cw == null) return;
		this.searchService.indexNote(note);
	}

	@bindThis
	private async renderNoteOrRenoteActivity(note: MiNote) {
		if (note.localOnly) return null;

		if (isRenote(note) && !isQuote(note)) {
			const renoteTarget = await this.notesRepository.findOneByOrFail({ id: note.renoteId });
			const targetUri = renoteTarget.uri ? renoteTarget.uri : `${this.config.url}/notes/${renoteTarget.id}`;
			const content = this.apRendererService.renderAnnounce(targetUri, note);
			return this.apRendererService.addContext(content);
		} else {
			const content = this.apRendererService.renderCreate(await this.apRendererService.renderNote(note, false), note);
			return this.apRendererService.addContext(content);
		}
	}

	@bindThis
	private async deliverActivity(note: MiNote, user: MiUser) {
		if (note.localOnly) return;
		if (!this.userEntityService.isLocalUser(user)) return;

		try {
			const noteActivity = await this.renderNoteOrRenoteActivity(note);
			const dm = this.apDeliverManagerService.createDeliverManager(user as MiLocalUser, noteActivity);

			const mentionedUsers = await this.fetchMentionedUsers(note);
			for (const u of mentionedUsers.filter(u => this.userEntityService.isRemoteUser(u))) {
				dm.addDirectRecipe(u as MiRemoteUser);
			}

			if (note.replyId && note.replyUserHost !== null) {
				const u = await this.usersRepository.findOneBy({ id: note.replyUserId! });
				if (u && this.userEntityService.isRemoteUser(u)) dm.addDirectRecipe(u);
			}

			if (note.renoteId && note.renoteUserHost !== null) {
				const u = await this.usersRepository.findOneBy({ id: note.renoteUserId! });
				if (u && this.userEntityService.isRemoteUser(u)) dm.addDirectRecipe(u);
			}

			if (['public', 'home', 'followers'].includes(note.visibility)) {
				dm.addFollowersRecipe();
			}

			if (['public'].includes(note.visibility)) {
				await this.relayService.deliverToRelays(user as MiLocalUser, noteActivity);
			}

			await dm.execute();
		} catch (err) {
			const errName = err instanceof Error ? err.name : 'Error';
			const errMsg = err instanceof Error ? err.message : String(err);
			this.logger.warn(`deliverActivity failed(${errName}: ${errMsg})`, {
				noteId: note.id,
				userId: user.id,
				e: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
			});
		}
	}
}
