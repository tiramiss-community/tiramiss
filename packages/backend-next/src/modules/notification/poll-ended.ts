/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { TransactionRunner } from '../../application/transaction.js';
import type { PostNotification, PostNotificationWrites } from './model.js';

export interface PollEndedNote {
	id: string;
	userId: string;
	hasPoll: boolean;
}

export interface PollEndedRecipient {
	userHost: string | null;
	// 本家 notificationRecieveConfig.pollEnded.type。未設定なら null。
	receiveConfig: string | null;
}

export interface PollEndedResult {
	notifiedUserIds: string[];
	failures: { recipientId: string; error: unknown }[];
}

/** 本家 EndedPollNotificationProcessorService.process と、通知元のない createNotification の受信判定。 */
export function createNotifyPollEnded(dependencies: {
	readNote(id: string): Promise<PollEndedNote | null>;
	// 投票したローカルユーザーの ID。複数選択の投票では同じ ID が重複してよい。
	readLocalVoterIds(noteId: string): Promise<string[]>;
	// プロフィールがなければ例外を投げる。本家も findOneByOrFail で失敗し、ジョブを失敗させる。
	readRecipient(userId: string): Promise<PollEndedRecipient>;
	notifications: TransactionRunner<PostNotificationWrites>;
	afterSaved?(notification: PostNotification): Promise<void>;
	newId(now: number): string;
	currentTime(): number;
}) {
	return {
		async notifyPollEnded(input: { noteId: string }): Promise<PollEndedResult> {
			const result: PollEndedResult = { notifiedUserIds: [], failures: [] };
			// 投稿の削除や投票の付け替えでジョブは取り消さない。実行時に読み直して、投票がなければ何もしない。
			const note = await dependencies.readNote(input.noteId);
			if (note === null || !note.hasPoll) {
				return result;
			}

			const voterIds = await dependencies.readLocalVoterIds(note.id);
			for (const userId of new Set([note.userId, ...voterIds])) {
				const recipient = await dependencies.readRecipient(userId);
				// 通知元がないため、ミュート・フォロー関係による受信条件は本家でも判定しない。
				if (recipient.userHost !== null || recipient.receiveConfig === 'never') {
					continue;
				}

				const now = dependencies.currentTime();
				const notification: PostNotification = {
					id: dependencies.newId(now), recipientId: userId, type: 'pollEnded', notifierId: null,
					noteId: note.id, targetNoteId: null, createdAtMs: now,
				};
				try {
					await dependencies.notifications.run(writes => writes.save(notification));
					result.notifiedUserIds.push(userId);
					await dependencies.afterSaved?.(notification);
				} catch (error) {
					// 本家は通知の作成を待たないため、1 人分の失敗でジョブも他の受信者への通知も止まらない。
					result.failures.push({ recipientId: userId, error });
				}
			}
			return result;
		},
	};
}
