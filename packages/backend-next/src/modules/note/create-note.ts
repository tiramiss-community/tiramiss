/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as mfm from 'mfm-js';
import { NoteCreateError } from './create-contract.js';
import { parseNoteInput } from './create-input.js';
import { concatNoteContentsForKeywordCheck } from './keywords.js';
import type { NewNote, NewPoll, NoteAttachableFile, NoteCreateActor, NoteCreateAuthor, NoteInput, NotePostSaveInput, NoteWrites } from './create-contract.js';
import type { TransactionRunner } from '../../application/transaction.js';

interface RelatedFacts {
	files: NoteAttachableFile[];
}

export function createCreateNote(dependencies: {
	readAuthor(id: string, now: number): Promise<NoteCreateAuthor | null>;
	limit(userId: string, factor: number): Promise<void>;
	// 指定した ID の順に、投稿者が所有するファイルだけを返す。
	readOwnedFiles(userId: string, fileIds: string[]): Promise<NoteAttachableFile[]>;
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

	// 本家と同じく、存在・所有権の確認は保存の transaction に入れない。確認後の削除は検出しない。
	async function fetchRelated(author: NoteCreateAuthor, data: NoteInput, now: number): Promise<RelatedFacts> {
		if (data.visibleUserIds.length > 0) {
			throw new NoteCreateError('NOT_IMPLEMENTED');
		}

		let files: NoteAttachableFile[] = [];
		if (data.fileIds.length > 0) {
			files = await dependencies.readOwnedFiles(author.id, data.fileIds);
			if (files.length !== data.fileIds.length) {
				throw new NoteCreateError('NO_SUCH_FILE');
			}
		}

		if (data.renoteId !== null || data.replyId !== null) {
			throw new NoteCreateError('NOT_IMPLEMENTED');
		}

		if (data.poll?.expiresAtMs != null && data.poll.expiresAtMs < now) {
			throw new NoteCreateError('CANNOT_CREATE_ALREADY_EXPIRED_POLL');
		}

		if (data.channelId !== null) {
			throw new NoteCreateError('NOT_IMPLEMENTED');
		}
		return { files };
	}

	function correct(author: NoteCreateAuthor, data: NoteInput, related: RelatedFacts, id: string): { note: NewNote; poll: NewPoll | null } {
		let visibility = data.visibility;
		if (visibility === 'public' &&
			(dependencies.matchesWords(data.cw ?? data.text ?? '', author.sensitiveWords) || !author.canPublicNote)) {
			visibility = 'home';
		}

		// 本家は trim 前の text で判定するため、trim より先に行う。
		const contents = concatNoteContentsForKeywordCheck({ cw: data.cw, text: data.text, pollChoices: data.poll?.choices ?? [] });
		if (dependencies.matchesWords(contents, author.prohibitedWords)) {
			throw new NoteCreateError('CONTAINS_PROHIBITED_WORDS');
		}

		const text = data.text?.trim() || null;

		// 抽出結果を保存できるまでは、メンション・ハッシュタグ・絵文字を黙って捨てずに拒否する。
		const tokens = [
			...(text ? mfm.parse(text) : []),
			...(data.cw ? mfm.parse(data.cw) : []),
			...(data.poll?.choices ?? []).flatMap(choice => mfm.parse(choice)),
		];
		const extracted = mfm.extract(tokens, node =>
			(node.type === 'mention' && !data.noExtractMentions) ||
			(node.type === 'hashtag' && !data.noExtractHashtags) ||
			(node.type === 'emojiCode' && !data.noExtractEmojis));
		if (extracted.length > 0) {
			throw new NoteCreateError('NOT_IMPLEMENTED');
		}

		const note: NewNote = {
			id, userId: author.id, userHost: author.host,
			text, cw: data.cw, visibility, localOnly: data.localOnly, reactionAcceptance: data.reactionAcceptance,
			channelId: null,
			fileIds: related.files.map(file => file.id),
			attachedFileTypes: related.files.map(file => file.type),
			hasPoll: data.poll !== null,
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
			const { note, poll } = correct(author, data, related, dependencies.newId(now));
			await save(note, poll);

			// 応答の入れ子は本家と同じく今回の count 加算前の値にするため、描画を終えてから後続を始める。
			// 描画に失敗しても Note は保存済みなので、後続は省略しない。
			try {
				return await render(note.id, author.id);
			} finally {
				dependencies.afterSaved({ userId: note.userId });
			}
		},
	};
}
