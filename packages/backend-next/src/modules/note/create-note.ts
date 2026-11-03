/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as mfm from 'mfm-js';
import { NoteCreateError } from './create-contract.js';
import { parseNoteInput } from './create-input.js';
import { concatNoteContentsForKeywordCheck } from './keywords.js';
import { isVisibleForViewer } from './visibility.js';
import type {
	MentionedRemoteUser, NewNote, NewPoll, NoteAttachableFile, NoteCreateActor, NoteCreateAuthor, NoteInput, NotePostSaveInput,
	NoteVisibility, NoteWrites, RelatedChannel, RelatedNote,
} from './create-contract.js';
import type { TransactionRunner } from '../../application/transaction.js';

interface RelatedFacts {
	files: NoteAttachableFile[];
	renote: RelatedNote | null;
	reply: RelatedNote | null;
	// 返信先による補正を終えた、保存先の channel。
	channel: RelatedChannel | null;
}

const visibilityOrder: NoteVisibility[] = ['public', 'home', 'followers', 'specified'];

// 本家 misc/is-renote.ts の isRenote && !isQuote。
function isPureRenote(note: RelatedNote): boolean {
	return note.renoteId !== null && note.text === null && note.cw === null && note.replyId === null && !note.hasPoll && note.fileIds.length === 0;
}

function narrowVisibility(visibility: NoteVisibility, target: NoteVisibility | undefined): NoteVisibility {
	return target !== undefined && visibilityOrder.indexOf(target) > visibilityOrder.indexOf(visibility) ? target : visibility;
}

export function createCreateNote(dependencies: {
	readAuthor(id: string, now: number): Promise<NoteCreateAuthor | null>;
	limit(userId: string, factor: number): Promise<void>;
	// 指定した ID の順に、投稿者が所有するファイルだけを返す。
	readOwnedFiles(userId: string, fileIds: string[]): Promise<NoteAttachableFile[]>;
	readNote(id: string): Promise<RelatedNote | null>;
	isBlocking(blockerId: string, blockeeId: string): Promise<boolean>;
	isFollowing(followerId: string, followeeId: string): Promise<boolean>;
	readChannel(id: string, options: { includeArchived: boolean }): Promise<RelatedChannel | null>;
	// 指定した ID の順に、リモートユーザーだけを返す。
	readMentionedRemoteUsers(userIds: string[]): Promise<MentionedRemoteUser[]>;
	writes: NoteWrites;
	transactions: TransactionRunner<NoteWrites>;
	afterSaved(input: NotePostSaveInput): void;
	newId(now: number): string;
	matchesWords(text: string, words: string[]): boolean;
}) {
	async function authorize(actor: NoteCreateActor | null, now: number): Promise<NoteCreateAuthor> {
		if (actor === null) {
			throw new NoteCreateError('CREDENTIAL_REQUIRED');
		}
		const author = await dependencies.readAuthor(actor.userId, now);
		if (author === null) {
			throw new NoteCreateError('AUTHENTICATION_FAILED');
		}
		if (author.rateLimitFactor > 0) {
			await dependencies.limit(actor.userId, author.rateLimitFactor);
		}
		if (author.isSuspended) {
			throw new NoteCreateError('YOUR_ACCOUNT_SUSPENDED');
		}
		if (author.movedToUri) {
			throw new NoteCreateError('YOUR_ACCOUNT_MOVED');
		}
		if (!actor.canWriteNote) {
			throw new NoteCreateError('PERMISSION_DENIED');
		}
		return author;
	}

	async function fetchRenote(author: NoteCreateAuthor, id: string, requestedChannelId: string | null): Promise<RelatedNote> {
		const renote = await dependencies.readNote(id);
		if (renote === null) {
			throw new NoteCreateError('NO_SUCH_RENOTE_TARGET');
		}
		if (isPureRenote(renote)) {
			throw new NoteCreateError('CANNOT_RENOTE_TO_A_PURE_RENOTE');
		}
		if (renote.userId !== author.id && await dependencies.isBlocking(renote.userId, author.id)) {
			throw new NoteCreateError('YOU_HAVE_BEEN_BLOCKED');
		}
		if ((renote.visibility === 'followers' && renote.userId !== author.id) || renote.visibility === 'specified') {
			throw new NoteCreateError('CANNOT_RENOTE_DUE_TO_VISIBILITY');
		}
		// 本家は返信先による channel の補正より前に、入力の channelId と比べる。補正後の保存先とは比べない。
		if (renote.channelId !== null && renote.channelId !== requestedChannelId) {
			const channel = await dependencies.readChannel(renote.channelId, { includeArchived: true });
			if (channel === null) {
				throw new NoteCreateError('NO_SUCH_CHANNEL');
			}
			if (!channel.allowRenoteToExternal) {
				throw new NoteCreateError('CANNOT_RENOTE_OUTSIDE_OF_CHANNEL');
			}
		}
		return renote;
	}

	async function fetchReply(author: NoteCreateAuthor, id: string, visibility: NoteVisibility): Promise<RelatedNote> {
		const reply = await dependencies.readNote(id);
		if (reply === null) {
			throw new NoteCreateError('NO_SUCH_REPLY_TARGET');
		}
		if (isPureRenote(reply)) {
			throw new NoteCreateError('CANNOT_REPLY_TO_A_PURE_RENOTE');
		}
		const following = reply.visibility === 'followers' && reply.userId !== author.id && await dependencies.isFollowing(author.id, reply.userId);
		if (!isVisibleForViewer(reply, author, following)) {
			throw new NoteCreateError('CANNOT_REPLY_TO_AN_INVISIBLE_NOTE');
		}
		if (reply.visibility === 'specified' && visibility !== 'specified') {
			throw new NoteCreateError('CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY');
		}
		if (reply.userId !== author.id && await dependencies.isBlocking(reply.userId, author.id)) {
			throw new NoteCreateError('YOU_HAVE_BEEN_BLOCKED');
		}
		return reply;
	}

	// 本家と同じく、存在・所有権・可視性・ブロックの確認は保存の transaction に入れない。確認後の変更は検出しない。
	async function fetchRelated(author: NoteCreateAuthor, data: NoteInput, now: number): Promise<RelatedFacts> {
		let files: NoteAttachableFile[] = [];
		if (data.fileIds.length > 0) {
			files = await dependencies.readOwnedFiles(author.id, data.fileIds);
			if (files.length !== data.fileIds.length) {
				throw new NoteCreateError('NO_SUCH_FILE');
			}
		}

		const renote = data.renoteId === null ? null : await fetchRenote(author, data.renoteId, data.channelId);
		const reply = data.replyId === null ? null : await fetchReply(author, data.replyId, data.visibility);

		if (data.poll?.expiresAtMs != null && data.poll.expiresAtMs < now) {
			throw new NoteCreateError('CANNOT_CREATE_ALREADY_EXPIRED_POLL');
		}

		let channel: RelatedChannel | null = null;
		if (data.channelId !== null) {
			channel = await dependencies.readChannel(data.channelId, { includeArchived: false });
			if (channel === null) {
				throw new NoteCreateError('NO_SUCH_CHANNEL');
			}
		}
		// 本家は返信先の channel へ寄せるときに isArchived を見ないため、アーカイブ済みの channel にも保存される。
		if (reply !== null && reply.channelId !== (channel?.id ?? null)) {
			channel = reply.channelId === null ? null : await dependencies.readChannel(reply.channelId, { includeArchived: true });
		}
		return { files, renote, reply, channel };
	}

	function correct(author: NoteCreateAuthor, data: NoteInput, related: RelatedFacts, id: string): { note: Omit<NewNote, 'mentionedRemoteUsers'>; poll: NewPoll | null } {
		const { renote, reply, channel } = related;
		let visibility = data.visibility;
		let localOnly = data.localOnly;
		if (channel !== null) {
			visibility = 'public';
			localOnly = true;
		}
		if (visibility === 'public' && channel === null &&
			(dependencies.matchesWords(data.cw ?? data.text ?? '', author.sensitiveWords) || !author.canPublicNote)) {
			visibility = 'home';
		}

		// 本家は trim 前の text で判定するため、trim より先に行う。
		const contents = concatNoteContentsForKeywordCheck({ cw: data.cw, text: data.text, pollChoices: data.poll?.choices ?? [] });
		if (dependencies.matchesWords(contents, author.prohibitedWords)) {
			throw new NoteCreateError('CONTAINS_PROHIBITED_WORDS');
		}

		// channel の強制より後に行うため、channel 投稿でも Renote 対象・返信先より広い公開範囲にはならない。
		visibility = narrowVisibility(narrowVisibility(visibility, renote?.visibility), reply?.visibility);
		if (channel === null && (renote?.localOnly || reply?.localOnly)) {
			localOnly = true;
		}
		// 本家 create() の cache によるブロック再確認は、DB の確認と食い違う競合時だけ 500 になるため移植しない。

		const text = data.text?.trim() || null;

		// 抽出結果・指定宛先を保存できるまでは、黙って捨てずに拒否する。
		const tokens = [
			...(text ? mfm.parse(text) : []),
			...(data.cw ? mfm.parse(data.cw) : []),
			...(data.poll?.choices ?? []).flatMap(choice => mfm.parse(choice)),
		];
		const extracted = mfm.extract(tokens, node =>
			(node.type === 'mention' && !data.noExtractMentions) ||
			(node.type === 'hashtag' && !data.noExtractHashtags) ||
			(node.type === 'emojiCode' && !data.noExtractEmojis));
		if (extracted.length > 0 || (visibility === 'specified' && data.visibleUserIds.length > 0)) {
			throw new NoteCreateError('NOT_IMPLEMENTED');
		}

		const mentions = reply !== null && reply.userId !== author.id ? [reply.userId] : [];
		// 本家は自分の Note への返信でも返信先作者を宛先へ足す。
		const visibleUserIds = visibility === 'specified' && reply !== null ? [reply.userId] : [];
		if (mentions.length > 0 && mentions.length > author.mentionLimit) {
			throw new NoteCreateError('CONTAINS_TOO_MANY_MENTIONS');
		}

		const note: Omit<NewNote, 'mentionedRemoteUsers'> = {
			id, userId: author.id, userHost: author.host,
			text, cw: data.cw, visibility, localOnly, reactionAcceptance: data.reactionAcceptance,
			channelId: channel?.id ?? null,
			fileIds: related.files.map(file => file.id),
			attachedFileTypes: related.files.map(file => file.type),
			hasPoll: data.poll !== null,
			replyId: reply?.id ?? null,
			renoteId: renote?.id ?? null,
			threadId: reply === null ? null : reply.threadId ?? reply.id,
			replyUserId: reply?.userId ?? null,
			replyUserHost: reply?.userHost ?? null,
			renoteUserId: renote?.userId ?? null,
			renoteUserHost: renote?.userHost ?? null,
			renoteChannelId: renote?.channelId ?? null,
			visibleUserIds,
			mentions,
		};
		const poll: NewPoll | null = data.poll === null ? null : {
			noteId: id, choices: data.poll.choices, multiple: data.poll.multiple, expiresAtMs: data.poll.expiresAtMs,
			votes: data.poll.choices.map(() => 0),
			noteVisibility: note.visibility, userId: note.userId, userHost: note.userHost, channelId: note.channelId,
		};
		return { note, poll };
	}

	async function save(note: NewNote, poll: NewPoll | null): Promise<void> {
		// 本家は投票なしの Note を単独で insert する。全投稿を transaction に入れる保証は追加しない。
		if (poll === null) {
			await dependencies.writes.insertNote(note);
			return;
		}
		await dependencies.transactions.run(async writes => {
			await writes.insertNote(note);
			await writes.insertPoll(poll);
		});
	}

	return {
		async createNote<T>(
			actor: NoteCreateActor | null,
			input: unknown,
			now: number,
			render: (noteId: string, viewerId: string) => Promise<T>,
		): Promise<T> {
			const author = await authorize(actor, now);
			const data = parseNoteInput(input, now);
			const related = await fetchRelated(author, data, now);
			const corrected = correct(author, data, related, dependencies.newId(now));
			const note: NewNote = {
				...corrected.note,
				mentionedRemoteUsers: corrected.note.mentions.length > 0 ? await dependencies.readMentionedRemoteUsers(corrected.note.mentions) : [],
			};
			await save(note, corrected.poll);

			// 応答の入れ子は本家と同じく今回の count 加算前の値にするため、描画を終えてから後続を始める。
			// 描画に失敗しても Note は保存済みなので、後続は省略しない。
			try {
				return await render(note.id, author.id);
			} finally {
				dependencies.afterSaved({
					userId: note.userId,
					repliedNoteId: note.replyId,
					// 本家は自分の Note の Renote と bot による Renote を数えない。返信は bot・自分宛てでも数える。
					renotedNoteId: related.renote !== null && related.renote.userId !== author.id && !author.isBot ? related.renote.id : null,
					channelId: note.channelId,
				});
			}
		},
	};
}
