/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { receivesPostNotification } from '../notification/public.js';
import { planNoteNotifications } from './notification-plan.js';
import type { NotificationReception, PostNotification, PostNotificationWrites } from '../notification/public.js';
import type { NoteCreatedSnapshot } from './create-contract.js';
import type { TransactionRunner } from '../../application/transaction.js';
import type { NoteNotificationPlanInput, PlannedNoteNotification } from './notification-plan.js';

const subscriptionConcurrency = 8;

export function createNoteCreatedEvents(ports: {
	read(noteId: string, snapshot?: NoteCreatedSnapshot): Promise<NoteNotificationPlanInput | null>;
	readSubscribers?(note: NoteNotificationPlanInput): Promise<NoteNotificationPlanInput['subscribers']>;
	isThreadMuted?(recipientId: string, threadId: string): Promise<boolean>;
	render(noteId: string, viewerId: string | null, options: { skipHide?: boolean; withReactionAndUserPairCache?: boolean }, snapshot?: NoteCreatedSnapshot): Promise<Record<string, unknown>>;
	webhook?(userId: string, type: 'note' | 'mention' | 'reply' | 'renote', note: Record<string, unknown>): Promise<void>;
	stream: { notes(note: Record<string, unknown>): Promise<void>; main(userId: string, type: string, note: Record<string, unknown>): Promise<void> };
	readReception(recipientId: string, notifierId: string, type: PostNotification['type']): Promise<NotificationReception>;
	notifications: TransactionRunner<PostNotificationWrites>;
	afterNotificationSaved(notification: PostNotification): Promise<void>;
	deliver(noteId: string): Promise<void>;
	newId(now: number): string;
	currentTime(): number;
}) {
	return async (noteId: string, snapshot?: NoteCreatedSnapshot): Promise<void> => {
		const note = await ports.read(noteId, snapshot);
		if (note === null) {
			return;
		}
		const pending: Promise<void>[] = [];
		const start = (work: Promise<void>) => {
			// 保存・publish の失敗は後続の準備を止めない。本家の detached 処理を終了待機へ接続する。
			pending.push(work);
			void work.catch(() => { });
		};
		const notify = async (planned: PlannedNoteNotification): Promise<void> => {
			const facts = await ports.readReception(planned.recipientId, note.userId, planned.type);
			if (!receivesPostNotification(facts)) {
				return;
			}
			const now = ports.currentTime();
			const notification: PostNotification = { ...planned, id: ports.newId(now), notifierId: note.userId, noteId, createdAtMs: now };
			await ports.notifications.run(writes => writes.save(notification));
			await ports.afterNotificationSaved(notification);
		};
		start((async () => {
			const subscribers = ports.readSubscribers ? await ports.readSubscribers(note) : note.subscribers;
			const subscriptions = planNoteNotifications({ ...note, subscribers }).filter(n => n.type === 'note');
			let next = 0;
			const errors: unknown[] = [];
			// PG保存の待機を購読者全員分まとめて作らず、各処理が終わってから次の宛先へ進む。
			const runSubscriptions = async () => {
				while (next < subscriptions.length) {
					const subscription = subscriptions[next++];
					try {
						await notify(subscription);
					} catch (error) {
						errors.push(error);
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(subscriptionConcurrency, subscriptions.length) }, runSubscriptions));
			if (errors.length > 0) {
				throw new AggregateError(errors, 'Subscription notifications failed');
			}
		})());

		const acceptedMentions: string[] = [];
		let acceptedReply: NoteNotificationPlanInput['reply'] = null;
		const threadMuted = (recipientId: string, threadId: string) => ports.isThreadMuted ? ports.isThreadMuted(recipientId, threadId) : Promise.resolve(note.threadMutedUserIds.has(recipientId));
		try {
			const packed = await ports.render(note.id, null, { skipHide: true, withReactionAndUserPairCache: true }, snapshot);
			start(ports.stream.notes(packed));
			if (ports.webhook) {
				start(ports.webhook(note.userId, 'note', packed));
			}
			for (const recipientId of note.mentions) {
				if (note.localUserIds.has(recipientId) && !await threadMuted(recipientId, note.threadId ?? note.id)) {
					const mentioned = await ports.render(note.id, recipientId, {}, snapshot);
					start(ports.stream.main(recipientId, 'mention', mentioned));
					if (ports.webhook) {
						start(ports.webhook(recipientId, 'mention', mentioned));
					}
					acceptedMentions.push(recipientId);
				}
			}
			if (note.reply !== null && note.localUserIds.has(note.reply.userId) && !await threadMuted(note.reply.userId, note.replyThreadId ?? note.reply.id)) {
				start(ports.stream.main(note.reply.userId, 'reply', packed));
				if (ports.webhook) {
					start(ports.webhook(note.reply.userId, 'reply', packed));
				}
				acceptedReply = note.reply;
			}
			if (note.renote !== null && note.userId !== note.renote.userId && note.localUserIds.has(note.renote.userId)) {
				start(ports.stream.main(note.renote.userId, 'renote', packed));
				if (ports.webhook) {
					start(ports.webhook(note.renote.userId, 'renote', packed));
				}
			}
			for (const planned of planNoteNotifications({ ...note, mentions: acceptedMentions, reply: acceptedReply, threadMutedUserIds: new Set() }).filter(n => n.type !== 'note')) {
				start(notify(planned));
			}
			start(ports.deliver(note.id));
		} catch (error) {
			// 本家はこの準備に失敗すると manager 通知・AP 配送へ進まない。先に開始した購読通知は残る。
			start(Promise.reject(error));
		}
		const settled = await Promise.allSettled(pending);
		const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Note creation events failed');
		}
	};
}
