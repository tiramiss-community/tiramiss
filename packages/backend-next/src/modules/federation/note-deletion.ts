/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { apContext } from './ap-context.js';
import { isPureRenote, renderNoteActivity } from './note-activity.js';
import { collectInboxes } from './deliver-recipients.js';
import type { NoteActivityNote } from './note-activity.js';
import type { DeliveryUser } from './note-delivery.js';
import type { DeliverBatch } from './deliver-job.js';
import type { FollowerInbox } from './deliver-recipients.js';

export function renderDeletedNoteActivity(materials: {
	note: NoteActivityNote;
	renote: { id: string; uri: string | null } | null;
}, options: { selfUrl: string; now: number; randomId: string; isLocalUri(uri: string): boolean }): Record<string, unknown> {
	const { note, renote } = materials;
	const actor = `${options.selfUrl}/users/${note.userId}`;
	const published = new Date(options.now).toISOString();
	if (isPureRenote(note) && renote !== null) {
		const { '@context': _, ...announce } = renderNoteActivity({ note, renote, reply: null, mentionedUsers: [], files: [], poll: null, emojis: [] }, options);
		const id = typeof announce.id === 'string' && options.isLocalUri(announce.id) ? `${announce.id}/undo` : `${options.selfUrl}/${options.randomId}`;
		return { '@context': apContext, type: 'Undo', id, actor, object: announce, published };
	}
	return { '@context': apContext, type: 'Delete', actor, object: { id: `${options.selfUrl}/notes/${note.id}`, type: 'Tombstone' }, published, id: `${options.selfUrl}/${options.randomId}` };
}

export function createDeliverDeletedNote<Snapshot extends { id: string; userId: string }>(ports: {
	readFollowerInboxes(userId: string): Promise<FollowerInbox[]>;
	readConcernedUsers(snapshot: Snapshot): Promise<DeliveryUser[]>;
	deliverToRelays(author: { id: string }, activity: Record<string, unknown>): Promise<void>;
	enqueue(batch: DeliverBatch): Promise<void>;
}) {
	return async (input: { snapshot: Snapshot; activity: Record<string, unknown> }): Promise<void> => {
		const { snapshot, activity } = input;
		const user = { id: snapshot.userId };
		const followers = async () => {
			const inboxes = await collectInboxes([{ type: 'Followers' }], () => ports.readFollowerInboxes(user.id));
			await ports.enqueue({ user, activity, inboxes });
		};
		const direct = async () => {
			const users = await ports.readConcernedUsers(snapshot);
			const recipes = users.filter(account => account.host !== null).map(to => ({ type: 'Direct' as const, to }));
			const inboxes = await collectInboxes(recipes, async () => []);
			await ports.enqueue({ user, activity, inboxes });
		};
		// 本家は別々の DeliverManager を使う。followers と direct の sharedInbox を横断して重複排除しない。
		const results = await Promise.allSettled([followers(), ports.deliverToRelays(user, activity), direct()]);
		const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
		if (failures.length === 1) {
			throw failures[0];
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, 'note deletion deliveries failed');
		}
	};
}
