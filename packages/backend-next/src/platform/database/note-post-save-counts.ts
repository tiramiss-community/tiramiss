/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiChannel, MiNote, MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { NotePostSaveInput } from '../../modules/note/public.js';
import { DiagnosticError } from '../diagnostic-error.js';

export function createNotePostSaveCounts(manager: EntityManager) {
	function countChannelNotes(channelId: string) {
		// 本家どおり時刻は後続処理の実行時に取る。要求開始時刻だと、遅れて終わった古い要求が lastNotedAt を巻き戻しうる。
		return manager.getRepository(MiChannel).createQueryBuilder().update()
			.set({ notesCount: () => '"notesCount" + 1', lastNotedAt: new Date() })
			.where('id = :channelId', { channelId }).execute();
	}

	async function countChannelUser(userId: string, channelId: string): Promise<void> {
		// 本家どおり、保存後の件数が 1 なら初投稿とみなす。削除では減らさず、同時の初投稿で取りこぼしうる点も本家と同じ。
		if (await manager.getRepository(MiNote).countBy({ userId, channelId }) === 1) {
			await manager.getRepository(MiChannel).createQueryBuilder().update()
				.set({ usersCount: () => '"usersCount" + 1' })
				.where('id = :channelId', { channelId }).execute();
		}
	}

	return async (input: NotePostSaveInput): Promise<void> => {
		const increment = (column: 'repliesCount' | 'renoteCount', noteId: string) => manager.getRepository(MiNote).createQueryBuilder().update()
			.set({ [column]: () => `"${column}" + 1` })
			.where('id = :noteId', { noteId }).execute();
		const steps = new Map<string, Promise<unknown>>([['user', manager.getRepository(MiUser).createQueryBuilder().update()
			.set({ notesCount: () => '"notesCount" + 1', updatedAt: new Date() })
			.where('id = :userId', { userId: input.userId }).execute()]]);
		if (input.repliedNoteId !== null) {
			steps.set('reply', increment('repliesCount', input.repliedNoteId));
		}
		if (input.renotedNoteId !== null) {
			steps.set('renote', increment('renoteCount', input.renotedNoteId));
		}
		if (input.channelId !== null) {
			steps.set('channel', countChannelNotes(input.channelId));
			steps.set('channelUser', countChannelUser(input.userId, input.channelId));
		}
		// 本家の加算は互いに独立しているため、1 つの失敗で他の加算を省かない。失敗はどの加算かが分かるようすべて残す。
		const names = [...steps.keys()];
		const results = await Promise.allSettled(steps.values());
		const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ step: names[index], error: result.reason }] : []);
		if (failures.length > 0) {
			throw new DiagnosticError('NOTE_POST_SAVE_COUNTS_FAILED', { failures });
		}
	};
}
