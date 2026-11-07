/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createNoteCreatedEvents, readNotePlan, renderNote } from '../modules/note/public.js';
import { createNoteNotificationReader } from '../platform/database/note-notifications.js';
import { createNotificationTransactions } from '../platform/database/poll-ended.js';
import { createNoteReader } from '../platform/database/note-reader.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { NoteCreatedSnapshot, NoteFacts } from '../modules/note/public.js';
import type { EntityManager, DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import type { RuntimeConfig } from '../config/types.js';
import type { PostNotification } from '../modules/notification/public.js';
import type { UserWebhookEvent } from '../platform/job-queue/user-webhook.js';
import type { createPostingStream } from '../platform/posting-stream.js';

export function createPostingNotifications(resources: {
	roleTimelines?(noteId: string, userId: string, note: Record<string, unknown>): Promise<void>;
	dataSource: DataSource; reactionsRedis: Redis; postingStream: ReturnType<typeof createPostingStream>; webhook?(userId: string, type: UserWebhookEvent, note: Record<string, unknown>): Promise<void>;
}, config: RuntimeConfig) {
	const codec = createIdCodec(config.id);
	const manager: EntityManager = resources.dataSource.manager;
	const facts = createNoteNotificationReader(manager);
	const reader = createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId });
	const render = async (noteId: string, viewerId: string | null, options: { skipHide?: boolean; withReactionAndUserPairCache?: boolean } = {}, snapshot?: NoteCreatedSnapshot) => {
		const now = Date.now();
		const snapshots = new Map<string, NoteFacts>();
		if (snapshot) {
			const original = snapshot.note;
			snapshots.set(original.id, {
				...original, createdAtMs: codec.createdAtFromId(original.id), name: null,
				renoteCount: 0, repliesCount: 0, clippedCount: 0, reactions: {}, reactionPairs: [], uri: null, url: null,
			});
			for (const related of [snapshot.reply, snapshot.renote]) {
				if (related?.eventFacts && !snapshots.has(related.id)) {
					snapshots.set(related.id, related.eventFacts);
				}
			}
		}
		const notes = await readNotePlan([noteId], async ids => {
			const loaded = new Map((await reader.readNotes(ids.filter(id => !snapshots.has(id)))).map(note => [note.id, note]));
			return ids.flatMap(id => snapshots.get(id) ?? loaded.get(id) ?? []);
		});
		const materials = await reader.readMaterials(notes, viewerId, now);

		return { note: renderNote(noteId, materials, viewerId, now, true, options), materials };
	};
	const afterNotificationSaved = async (notification: PostNotification): Promise<void> => {
		if (!await facts.canPublish(notification.recipientId, notification.notifierId)) {
			return;
		}
		const { note, materials } = await render(notification.noteId, notification.recipientId);
		const notifier = notification.notifierId === null ? undefined : materials.authors.get(notification.notifierId)?.view;
		if (notification.notifierId !== null && notifier === undefined) {
			return;
		}
		await resources.postingStream.main(notification.recipientId, 'notification', {
			id: notification.id, createdAt: new Date(notification.createdAtMs).toISOString(), type: notification.type,
			...(notification.notifierId === null ? {} : { userId: notification.notifierId, user: notifier }), note,
		});
	};
	return {
		afterNotificationSaved,
		createdEvents: (deliver: (noteId: string) => Promise<void>, index?: (noteId: string, snapshot?: NoteCreatedSnapshot) => Promise<void>) => {
			const events = createNoteCreatedEvents({
				...facts, render: async (noteId, viewerId, options, snapshot) => (await render(noteId, viewerId, options, snapshot)).note,
				stream: resources.postingStream, roleTimelines: resources.roleTimelines, webhook: resources.webhook, notifications: createNotificationTransactions(resources.dataSource),
				afterNotificationSaved, deliver, index, newId: codec.newId, currentTime: Date.now,
			});
			return (noteId: string, input?: { createdSnapshot?: NoteCreatedSnapshot }) => events(noteId, input?.createdSnapshot);
		},
	};
}
