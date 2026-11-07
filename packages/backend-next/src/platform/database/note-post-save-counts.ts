/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiChannel, MiNote, MiUser } from 'backend-upstream/entities';
import { DiagnosticError } from '../diagnostic-error.js';
import type { EntityManager } from 'typeorm';
import type { NotePostSaveInput } from '../../modules/note/public.js';

export function createNotePostSaveCounts(manager: EntityManager) {
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
		// 本家の加算は互いに独立しているため、1 つの失敗で他の加算を省かない。失敗はどの加算かが分かるようすべて残す。
		const names = [...steps.keys()];
		const results = await Promise.allSettled(steps.values());
		const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ step: names[index], error: result.reason }] : []);
		if (failures.length > 0) {
			throw new DiagnosticError('NOTE_POST_SAVE_COUNTS_FAILED', { failures });
		}
	};
}

export function createNotePostSaveChannelCounts(manager: EntityManager) {
	return async (input: { userId: string; channelId: string | null }): Promise<void> => {
		if (input.channelId === null) {
			return;
		}
		const { channelId, userId } = input;
		const steps = new Map<string, Promise<unknown>>();
		const start = (name: string, run: () => Promise<unknown>) => {
			try {
				steps.set(name, run());
			} catch (error) {
				steps.set(name, Promise.reject(error));
			}
		};
		start('channelNotes', () => manager.getRepository(MiChannel).createQueryBuilder().update()
			.set({ notesCount: () => '"notesCount" + 1' }).where('id = :channelId', { channelId }).execute());
		// 本家は加算と時刻を別々に開始する。片方のSQLが失敗しても他を失わない。
		start('channelLastNotedAt', () => manager.getRepository(MiChannel).createQueryBuilder().update()
			.set({ lastNotedAt: new Date() }).where('id = :channelId', { channelId }).execute());
		start('channelUser', async () => {
			// 初回だけ加算し、削除では戻さない。本家の同時初投稿の競合も変えない。
			if (await manager.getRepository(MiNote).countBy({ userId, channelId }) === 1) {
				await manager.getRepository(MiChannel).createQueryBuilder().update()
					.set({ usersCount: () => '"usersCount" + 1' }).where('id = :channelId', { channelId }).execute();
			}
		});
		const results = await Promise.allSettled(steps.values()); const names = [...steps.keys()];
		const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ step: names[index], error: result.reason }] : []);
		if (failures.length > 0) {
			throw new DiagnosticError('NOTE_POST_SAVE_COUNTS_FAILED', { failures });
		}
	};
}
