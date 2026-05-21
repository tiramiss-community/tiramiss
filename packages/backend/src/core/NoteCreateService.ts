/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as mfm from 'mfm-js';
import { In, DataSource } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { extractMentions } from '@/misc/extract-mentions.js';
import { extractCustomEmojisFromMfm } from '@/misc/extract-custom-emojis-from-mfm.js';
import { extractHashtags } from '@/misc/extract-hashtags.js';
import type { IMentionedRemoteUsers } from '@/models/Note.js';
import { MiNote } from '@/models/Note.js';
import type { BlockingsRepository, ChannelsRepository, DriveFilesRepository, MiMeta, NotesRepository, NoteThreadMutingsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiApp } from '@/models/App.js';
import { concat } from '@/misc/prelude/array.js';
import { IdService } from '@/core/IdService.js';
import type { MiUser } from '@/models/User.js';
import type { IPoll } from '@/models/Poll.js';
import { MiPoll } from '@/models/Poll.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import type { MiChannel } from '@/models/Channel.js';
import { normalizeForSearch } from '@/misc/normalize-for-search.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { QueueService } from '@/core/QueueService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { RemoteUserResolveService } from '@/core/RemoteUserResolveService.js';
import { bindThis } from '@/decorators.js';
import { DB_MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import { RoleService } from '@/core/RoleService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';

type MinimumUser = {
	id: MiUser['id'];
	host: MiUser['host'];
	username: MiUser['username'];
	uri: MiUser['uri'];
};

type Option = {
	createdAt?: Date | null;
	name?: string | null;
	text?: string | null;
	reply?: MiNote | null;
	renote?: MiNote | null;
	files?: MiDriveFile[] | null;
	poll?: IPoll | null;
	localOnly?: boolean | null;
	reactionAcceptance?: MiNote['reactionAcceptance'];
	cw?: string | null;
	visibility?: string;
	visibleUsers?: MinimumUser[] | null;
	channel?: MiChannel | null;
	apMentions?: MinimumUser[] | null;
	apHashtags?: string[] | null;
	apEmojis?: string[] | null;
	uri?: string | null;
	url?: string | null;
	app?: MiApp | null;
};

@Injectable()
export class NoteCreateService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.channelsRepository)
		private channelsRepository: ChannelsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.noteThreadMutingsRepository)
		private noteThreadMutingsRepository: NoteThreadMutingsRepository,

		private userEntityService: UserEntityService,
		private noteEntityService: NoteEntityService,
		private globalEventService: GlobalEventService,
		private idService: IdService,
		private queueService: QueueService,
		private remoteUserResolveService: RemoteUserResolveService,
		private roleService: RoleService,
		private utilityService: UtilityService,
		private userBlockingService: UserBlockingService,
	) {
	}

	@bindThis
	public async fetchAndCreate(user: {
		id: MiUser['id'];
		username: MiUser['username'];
		host: MiUser['host'];
		isBot: MiUser['isBot'];
		isCat: MiUser['isCat'];
	}, data: {
		createdAt: Date;
		replyId: MiNote['id'] | null;
		renoteId: MiNote['id'] | null;
		fileIds: MiDriveFile['id'][];
		text: string | null;
		cw: string | null;
		visibility: string;
		visibleUserIds: MiUser['id'][];
		channelId: MiChannel['id'] | null;
		localOnly: boolean;
		reactionAcceptance: MiNote['reactionAcceptance'];
		poll: IPoll | null;
		apMentions?: MinimumUser[] | null;
		apHashtags?: string[] | null;
		apEmojis?: string[] | null;
	}): Promise<MiNote> {
		const visibleUsers = data.visibleUserIds.length > 0 ? await this.usersRepository.findBy({
			id: In(data.visibleUserIds),
		}) : [];

		let files: MiDriveFile[] = [];
		if (data.fileIds.length > 0) {
			files = await this.driveFilesRepository.createQueryBuilder('file')
				.where('file.userId = :userId AND file.id IN (:...fileIds)', {
					userId: user.id,
					fileIds: data.fileIds,
				})
				.orderBy('array_position(ARRAY[:...fileIds], "id"::text)')
				.setParameters({ fileIds: data.fileIds })
				.getMany();

			if (files.length !== data.fileIds.length) {
				throw new IdentifiableError('801c046c-5bf5-4234-ad2b-e78fc20a2ac7', 'No such file');
			}
		}

		let renote: MiNote | null = null;
		if (data.renoteId != null) {
			// Fetch renote to note
			renote = await this.notesRepository.findOne({
				where: { id: data.renoteId },
				relations: ['user', 'renote', 'reply'],
			});

			if (renote == null) {
				throw new IdentifiableError('53983c56-e163-45a6-942f-4ddc485d4290', 'No such renote target');
			} else if (isRenote(renote) && !isQuote(renote)) {
				throw new IdentifiableError('bde24c37-121f-4e7d-980d-cec52f599f02', 'Cannot renote pure renote');
			}

			// Check blocking
			if (renote.userId !== user.id) {
				const blockExist = await this.blockingsRepository.exists({
					where: {
						blockerId: renote.userId,
						blockeeId: user.id,
					},
				});
				if (blockExist) {
					throw new IdentifiableError('2b4fe776-4414-4a2d-ae39-f3418b8fd4d3', 'You have been blocked by the user');
				}
			}

			if (renote.visibility === 'followers' && renote.userId !== user.id) {
				// 他人のfollowers noteはreject
				throw new IdentifiableError('90b9d6f0-893a-4fef-b0f1-e9a33989f71a', 'Renote target visibility');
			} else if (renote.visibility === 'specified') {
				// specified / direct noteはreject
				throw new IdentifiableError('48d7a997-da5c-4716-b3c3-92db3f37bf7d', 'Renote target visibility');
			}

			if (renote.channelId && renote.channelId !== data.channelId) {
				// チャンネルのノートに対しリノート要求がきたとき、チャンネル外へのリノート可否をチェック
				// リノートのユースケースのうち、チャンネル内→チャンネル外は少数だと考えられるため、JOINはせず必要な時に都度取得する
				const renoteChannel = await this.channelsRepository.findOneBy({ id: renote.channelId });
				if (renoteChannel == null) {
					// リノートしたいノートが書き込まれているチャンネルが無い
					throw new IdentifiableError('b060f9a6-8909-4080-9e0b-94d9fa6f6a77', 'No such channel');
				} else if (!renoteChannel.allowRenoteToExternal) {
					// リノート作成のリクエストだが、対象チャンネルがリノート禁止だった場合
					throw new IdentifiableError('7e435f4a-780d-4cfc-a15a-42519bd6fb67', 'Channel does not allow renote to external');
				}
			}
		}

		let reply: MiNote | null = null;
		if (data.replyId != null) {
			// Fetch reply
			reply = await this.notesRepository.findOne({
				where: { id: data.replyId },
				relations: ['user'],
			});

			if (reply == null) {
				throw new IdentifiableError('60142edb-1519-408e-926d-4f108d27bee0', 'No such reply target');
			} else if (isRenote(reply) && !isQuote(reply)) {
				throw new IdentifiableError('f089e4e2-c0e7-4f60-8a23-e5a6bf786b36', 'Cannot reply to pure renote');
			} else if (!await this.noteEntityService.isVisibleForMe(reply, user.id)) {
				throw new IdentifiableError('11cd37b3-a411-4f77-8633-c580ce6a8dce', 'No such reply target');
			} else if (reply.visibility === 'specified' && data.visibility !== 'specified') {
				throw new IdentifiableError('ced780a1-2012-4caf-bc7e-a95a291294cb', 'Cannot reply to specified note with different visibility');
			}

			// Check blocking
			if (reply.userId !== user.id) {
				const blockExist = await this.blockingsRepository.exists({
					where: {
						blockerId: reply.userId,
						blockeeId: user.id,
					},
				});
				if (blockExist) {
					throw new IdentifiableError('b0df6025-f2e8-44b4-a26a-17ad99104612', 'You have been blocked by the user');
				}
			}
		}

		if (data.poll) {
			if (data.poll.expiresAt != null) {
				if (data.poll.expiresAt.getTime() < Date.now()) {
					throw new IdentifiableError('0c11c11e-0c8d-48e7-822c-76ccef660068', 'Poll expiration must be future time');
				}
			}
		}

		let channel: MiChannel | null = null;
		if (data.channelId != null) {
			channel = await this.channelsRepository.findOneBy({ id: data.channelId, isArchived: false });

			if (channel == null) {
				throw new IdentifiableError('bfa3905b-25f5-4894-b430-da331a490e4b', 'No such channel');
			}
		}

		return this.create(user, {
			createdAt: data.createdAt,
			files: files,
			poll: data.poll,
			text: data.text,
			reply,
			renote,
			cw: data.cw,
			localOnly: data.localOnly,
			reactionAcceptance: data.reactionAcceptance,
			visibility: data.visibility,
			visibleUsers,
			channel,
			apMentions: data.apMentions,
			apHashtags: data.apHashtags,
			apEmojis: data.apEmojis,
		});
	}

	@bindThis
	public async create(user: {
		id: MiUser['id'];
		username: MiUser['username'];
		host: MiUser['host'];
		isBot: MiUser['isBot'];
		isCat: MiUser['isCat'];
	}, data: Option, silent = false): Promise<MiNote> {
		// チャンネル外にリプライしたら対象のスコープに合わせる
		// (クライアントサイドでやっても良い処理だと思うけどとりあえずサーバーサイドで)
		if (data.reply && data.channel && data.reply.channelId !== data.channel.id) {
			if (data.reply.channelId) {
				data.channel = await this.channelsRepository.findOneBy({ id: data.reply.channelId });
			} else {
				data.channel = null;
			}
		}

		// チャンネル内にリプライしたら対象のスコープに合わせる
		// (クライアントサイドでやっても良い処理だと思うけどとりあえずサーバーサイドで)
		if (data.reply && (data.channel == null) && data.reply.channelId) {
			data.channel = await this.channelsRepository.findOneBy({ id: data.reply.channelId });
		}

		if (data.createdAt == null) data.createdAt = new Date();
		if (data.visibility == null) data.visibility = 'public';
		if (data.localOnly == null) data.localOnly = false;
		if (data.channel != null) data.visibility = 'public';
		if (data.channel != null) data.visibleUsers = [];
		if (data.channel != null) data.localOnly = true;

		if (data.visibility === 'public' && data.channel == null) {
			const sensitiveWords = this.meta.sensitiveWords;
			if (this.utilityService.isKeyWordIncluded(data.cw ?? data.text ?? '', sensitiveWords)) {
				data.visibility = 'home';
			} else if ((await this.roleService.getUserPolicies(user.id)).canPublicNote === false) {
				data.visibility = 'home';
			}
		}

		const hasProhibitedWords = this.checkProhibitedWordsContain({
			cw: data.cw,
			text: data.text,
			pollChoices: data.poll?.choices,
		}, this.meta.prohibitedWords);

		if (hasProhibitedWords) {
			throw new IdentifiableError('689ee33f-f97c-479a-ac49-1b9f8140af99', 'Note contains prohibited words');
		}

		const inSilencedInstance = this.utilityService.isSilencedHost(this.meta.silencedHosts, user.host);

		if (data.visibility === 'public' && inSilencedInstance && user.host !== null) {
			data.visibility = 'home';
		}

		if (data.renote) {
			switch (data.renote.visibility) {
				case 'public':
					// public noteは無条件にrenote可能
					break;
				case 'home':
					// home noteはhome以下にrenote可能
					if (data.visibility === 'public') {
						data.visibility = 'home';
					}
					break;
				case 'followers':
					// 他人のfollowers noteはreject
					if (data.renote.userId !== user.id) {
						throw new Error('Renote target is not public or home');
					}

					// Renote対象がfollowersならfollowersにする
					data.visibility = 'followers';
					break;
				case 'specified':
					// specified / direct noteはreject
					throw new Error('Renote target is not public or home');
			}
		}

		// Check blocking
		if (this.isRenote(data) && !this.isQuote(data)) {
			if (data.renote.userHost === null) {
				if (data.renote.userId !== user.id) {
					const blocked = await this.userBlockingService.checkBlocked(data.renote.userId, user.id);
					if (blocked) {
						throw new Error('blocked');
					}
				}
			}
		}

		// 返信対象がpublicではないならhomeにする
		if (data.reply && data.reply.visibility !== 'public' && data.visibility === 'public') {
			data.visibility = 'home';
		}

		// ローカルのみをRenoteしたらローカルのみにする
		if (data.renote && data.renote.localOnly && data.channel == null) {
			data.localOnly = true;
		}

		// ローカルのみにリプライしたらローカルのみにする
		if (data.reply && data.reply.localOnly && data.channel == null) {
			data.localOnly = true;
		}

		if (data.text) {
			if (data.text.length > DB_MAX_NOTE_TEXT_LENGTH) {
				data.text = data.text.slice(0, DB_MAX_NOTE_TEXT_LENGTH);
			}
			data.text = data.text.trim();
			if (data.text === '') {
				data.text = null;
			}
		} else {
			data.text = null;
		}

		let tags = data.apHashtags;
		let emojis = data.apEmojis;
		let mentionedUsers = data.apMentions;

		// Parse MFM if needed
		if (!tags || !emojis || !mentionedUsers) {
			const tokens = (data.text ? mfm.parse(data.text)! : []);
			const cwTokens = data.cw ? mfm.parse(data.cw)! : [];
			const choiceTokens = data.poll && data.poll.choices
				? concat(data.poll.choices.map(choice => mfm.parse(choice)!))
				: [];

			const combinedTokens = tokens.concat(cwTokens).concat(choiceTokens);

			tags = data.apHashtags ?? extractHashtags(combinedTokens);

			emojis = data.apEmojis ?? extractCustomEmojisFromMfm(combinedTokens);

			mentionedUsers = data.apMentions ?? await this.extractMentionedUsers(user, combinedTokens);
		}

		// if the host is media-silenced, custom emojis are not allowed
		if (this.utilityService.isMediaSilencedHost(this.meta.mediaSilencedHosts, user.host)) emojis = [];

		tags = tags.filter(tag => Array.from(tag).length <= 128).splice(0, 32);

		if (data.reply && (user.id !== data.reply.userId) && !mentionedUsers.some(u => u.id === data.reply!.userId)) {
			mentionedUsers.push(await this.usersRepository.findOneByOrFail({ id: data.reply!.userId }));
		}

		if (data.visibility === 'specified') {
			if (data.visibleUsers == null) throw new Error('invalid param');

			for (const u of data.visibleUsers) {
				if (!mentionedUsers.some(x => x.id === u.id)) {
					mentionedUsers.push(u);
				}
			}

			if (data.reply && !data.visibleUsers.some(x => x.id === data.reply!.userId)) {
				data.visibleUsers.push(await this.usersRepository.findOneByOrFail({ id: data.reply!.userId }));
			}
		}

		if (mentionedUsers.length > 0 && mentionedUsers.length > (await this.roleService.getUserPolicies(user.id)).mentionLimit) {
			throw new IdentifiableError('9f466dab-c856-48cd-9e65-ff90ff750580', 'Note contains too many mentions');
		}

		const note = await this.insertNote(user, data, tags, emojis, mentionedUsers);

		// Streaming events must fire immediately (before job queue) to satisfy realtime latency
		if (!silent) {
			const noteObj = await this.noteEntityService.pack(note, null, { skipHide: true, withReactionAndUserPairCache: true });
			this.globalEventService.publishNotesStream(noteObj);
			this.roleService.addNoteToRoleTimeline(noteObj);

			if (data.reply && data.reply.userHost === null) {
				const threadId = note.threadId ?? data.reply.id;
				const isThreadMuted = await this.noteThreadMutingsRepository.exists({
					where: { userId: data.reply.userId, threadId },
				});
				if (!isThreadMuted) {
					this.globalEventService.publishMainStream(data.reply.userId, 'reply', noteObj);
				}
			}

			if (data.renote && (user.id !== data.renote.userId) && data.renote.userHost === null) {
				this.globalEventService.publishMainStream(data.renote.userId, 'renote', noteObj);
			}

			const localMentionedUsers = mentionedUsers.filter(u => this.userEntityService.isLocalUser(u));
			if (localMentionedUsers.length > 0) {
				const threadId = note.threadId ?? note.id;
				const muted = await this.noteThreadMutingsRepository.find({
					where: { threadId, userId: In(localMentionedUsers.map(u => u.id)) },
					select: ['userId'],
				});
				const mutedUserIds = new Set(muted.map(x => x.userId));
				for (const u of localMentionedUsers) {
					if (mutedUserIds.has(u.id)) continue;
					const detailPackedNote = await this.noteEntityService.pack(note, u, { detail: true });
					this.globalEventService.publishMainStream(u.id, 'mention', detailPackedNote);
				}
			}
		}

		this.queueService.notePost(note.id, silent);

		return note;
	}

	@bindThis
	private async insertNote(user: { id: MiUser['id']; host: MiUser['host']; }, data: Option, tags: string[], emojis: string[], mentionedUsers: MinimumUser[]) {
		const insert = new MiNote({
			id: this.idService.gen(data.createdAt?.getTime()),
			fileIds: data.files ? data.files.map(file => file.id) : [],
			replyId: data.reply ? data.reply.id : null,
			renoteId: data.renote ? data.renote.id : null,
			channelId: data.channel ? data.channel.id : null,
			threadId: data.reply
				? data.reply.threadId
					? data.reply.threadId
					: data.reply.id
				: null,
			name: data.name,
			text: data.text,
			hasPoll: data.poll != null,
			cw: data.cw ?? null,
			tags: tags.map(tag => normalizeForSearch(tag)),
			emojis,
			userId: user.id,
			localOnly: data.localOnly!,
			reactionAcceptance: data.reactionAcceptance ?? null,
			visibility: data.visibility as any,
			visibleUserIds: data.visibility === 'specified'
				? data.visibleUsers
					? data.visibleUsers.map(u => u.id)
					: []
				: [],

			attachedFileTypes: data.files ? data.files.map(file => file.type) : [],

			// 以下非正規化データ
			replyUserId: data.reply ? data.reply.userId : null,
			replyUserHost: data.reply ? data.reply.userHost : null,
			renoteUserId: data.renote ? data.renote.userId : null,
			renoteUserHost: data.renote ? data.renote.userHost : null,
			renoteChannelId: data.renote ? data.renote.channelId : null,
			userHost: user.host,
		});

		if (data.uri != null) insert.uri = data.uri;
		if (data.url != null) insert.url = data.url;

		// Append mentions data
		if (mentionedUsers.length > 0) {
			insert.mentions = mentionedUsers.map(u => u.id);
			const profiles = await this.userProfilesRepository.findBy({ userId: In(insert.mentions) });
			insert.mentionedRemoteUsers = JSON.stringify(mentionedUsers.filter(u => this.userEntityService.isRemoteUser(u)).map(u => {
				const profile = profiles.find(p => p.userId === u.id);
				const url = profile != null ? profile.url : null;
				return {
					uri: u.uri,
					url: url ?? undefined,
					username: u.username,
					host: u.host,
				} as IMentionedRemoteUsers[0];
			}));
		}

		// 投稿を作成
		try {
			if (insert.hasPoll) {
				// Start transaction
				await this.db.transaction(async transactionalEntityManager => {
					await transactionalEntityManager.insert(MiNote, insert);

					const poll = new MiPoll({
						noteId: insert.id,
						choices: data.poll!.choices,
						expiresAt: data.poll!.expiresAt,
						multiple: data.poll!.multiple,
						votes: new Array(data.poll!.choices.length).fill(0),
						noteVisibility: insert.visibility,
						userId: user.id,
						userHost: user.host,
						channelId: insert.channelId,
					});

					await transactionalEntityManager.insert(MiPoll, poll);
				});
			} else {
				await this.notesRepository.insert(insert);
			}

			return {
				...insert,
				reply: data.reply ?? null,
				renote: data.renote ?? null,
			};
		} catch (e) {
			// duplicate key error
			if (isDuplicateKeyValueError(e)) {
				const err = new Error('Duplicated note');
				err.name = 'duplicated';
				throw err;
			}

			console.error(e);

			throw e;
		}
	}

	@bindThis
	private isRenote(note: Option): note is Option & { renote: MiNote } {
		return note.renote != null;
	}

	@bindThis
	private isQuote(note: Option & { renote: MiNote }): note is Option & { renote: MiNote } & (
		{ text: string } | { cw: string } | { reply: MiNote } | { poll: IPoll } | { files: MiDriveFile[] }
	) {
		// NOTE: SYNC WITH misc/is-quote.ts
		return note.text != null ||
			note.reply != null ||
			note.cw != null ||
			note.poll != null ||
			(note.files != null && note.files.length > 0);
	}

	@bindThis
	private async extractMentionedUsers(user: { host: MiUser['host']; }, tokens: mfm.MfmNode[]): Promise<MiUser[]> {
		if (tokens == null) return [];

		const mentions = extractMentions(tokens);
		let mentionedUsers = (await Promise.all(mentions.map(m =>
			this.remoteUserResolveService.resolveUser(m.username, m.host ?? user.host).catch(() => null),
		))).filter(x => x != null);

		// Drop duplicate users
		mentionedUsers = mentionedUsers.filter((u, i, self) =>
			i === self.findIndex(u2 => u.id === u2.id),
		);

		return mentionedUsers;
	}

	public checkProhibitedWordsContain(content: Parameters<UtilityService['concatNoteContentsForKeyWordCheck']>[0], prohibitedWords?: string[]) {
		if (prohibitedWords == null) {
			prohibitedWords = this.meta.prohibitedWords;
		}

		if (
			this.utilityService.isKeyWordIncluded(
				this.utilityService.concatNoteContentsForKeyWordCheck(content),
				prohibitedWords,
			)
		) {
			return true;
		}

		return false;
	}
}
