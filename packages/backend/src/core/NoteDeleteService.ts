/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets, In, IsNull, Not } from 'typeorm';
import { Injectable, Inject } from '@nestjs/common';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { MiNote, IMentionedRemoteUsers } from '@/models/Note.js';
import type { InstancesRepository, MiMeta, NotesRepository, UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import { SearchService } from '@/core/SearchService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { QueueService } from '@/core/QueueService.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';

@Injectable()
export class NoteDeleteService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private apRendererService: ApRendererService,
		private searchService: SearchService,
		private moderationLogService: ModerationLogService,
		private queueService: QueueService,
	) {}

	/**
	 * 投稿を削除します。
	 * @param user 投稿者
	 * @param note 投稿
	 */
	async delete(user: { id: MiUser['id']; uri: MiUser['uri']; host: MiUser['host']; isBot: MiUser['isBot']; }, note: MiNote, quiet = false, deleter?: MiUser) {
		const deletedAt = new Date();

		if (note.replyId) {
			await this.notesRepository.decrement({ id: note.replyId }, 'repliesCount', 1);
		}

		// AP 配信用コンテンツをノート削除前に生成 (削除後は renote 等の参照ができない)
		let apContent: any | null = null;
		let apRecipientIds: string[] = [];

		if (!quiet && this.userEntityService.isLocalUser(user) && !note.localOnly) {
			let renote: MiNote | null = null;
			if (isRenote(note) && !isQuote(note)) {
				renote = await this.notesRepository.findOneBy({ id: note.renoteId });
			}

			apContent = this.apRendererService.addContext(renote
				? this.apRendererService.renderUndo(this.apRendererService.renderAnnounce(renote.uri ?? `${this.config.url}/notes/${renote.id}`, note), user)
				: this.apRendererService.renderDelete(this.apRendererService.renderTombstone(`${this.config.url}/notes/${note.id}`), user));

			const [mentionedRemoteUsers, renotedOrRepliedRemoteUsers] = await Promise.all([
				this.getMentionedRemoteUsers(note),
				this.getRenotedOrRepliedRemoteUsers(note),
			]);
			const allRecipients = [...mentionedRemoteUsers, ...renotedOrRepliedRemoteUsers];
			apRecipientIds = [...new Set(allRecipients.map(u => u.id))];
		}

		if (!quiet) {
			this.globalEventService.publishNoteStream(note, 'deleted', { deletedAt });
		}

		this.searchService.unindexNote(note);

		await this.notesRepository.delete({
			id: note.id,
			userId: user.id,
		});

		if (deleter && (note.userId !== deleter.id)) {
			const noteUser = await this.usersRepository.findOneByOrFail({ id: note.userId });
			this.moderationLogService.log(deleter, 'deleteNote', {
				noteId: note.id,
				noteUserId: note.userId,
				noteUserUsername: noteUser.username,
				noteUserHost: noteUser.host,
				note: note,
			});
		}

		// チャート / 連合統計 / AP 配信をジョブキューに委譲
		this.queueService.noteDelete({
			noteId: note.id,
			quiet,
			userSnapshot: { id: user.id, uri: user.uri, host: user.host, isBot: user.isBot },
			noteSnapshot: {
				id: note.id,
				userId: note.userId,
				userHost: note.userHost,
				visibility: note.visibility,
				localOnly: note.localOnly,
				channelId: note.channelId,
				replyId: note.replyId,
				renoteId: note.renoteId,
				fileIds: note.fileIds,
			},
			apContent,
			apRecipientIds,
			isRemote: this.userEntityService.isRemoteUser(user),
		});
	}

	@bindThis
	private async getMentionedRemoteUsers(note: MiNote) {
		const where = [] as any[];

		const uris = (JSON.parse(note.mentionedRemoteUsers) as IMentionedRemoteUsers).map(x => x.uri);
		if (uris.length > 0) {
			where.push({ uri: In(uris) });
		}

		if (note.renoteUserId) {
			where.push({ id: note.renoteUserId });
		}

		if (where.length === 0) return [];

		return await this.usersRepository.find({ where }) as MiRemoteUser[];
	}

	@bindThis
	private async getRenotedOrRepliedRemoteUsers(note: MiNote) {
		const query = this.notesRepository.createQueryBuilder('note')
			.leftJoinAndSelect('note.user', 'user')
			.where(new Brackets(qb => {
				qb.orWhere('note.renoteId = :renoteId', { renoteId: note.id });
				qb.orWhere('note.replyId = :replyId', { replyId: note.id });
			}))
			.andWhere({ userHost: Not(IsNull()) });
		const notes = await query.getMany() as (MiNote & { user: MiRemoteUser })[];
		return notes.map(({ user }) => user);
	}
}
