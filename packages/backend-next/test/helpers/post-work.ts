/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { ApWorkRequest, NotificationWorkRequest } from '../../src/modules/post-work/public.js';

export function apRequest(suffix = ''): ApWorkRequest {
	const id = `https://example.test/activities/create${suffix}`;
	return {
		requestId: `request${suffix}`, eventId: `event${suffix}`, noteId: `note${suffix}`, actorId: 'actor',
		note: { visibility: 'public', localOnly: false, channelId: null },
		noteGeneration: 1, kind: 'ap.expand', schemaVersion: 1,
		occurredAtMs: 1792540800000, notBeforeMs: 1792540800000,
		payload: {
			activity: { id, type: 'Create', body: JSON.stringify({ id, type: 'Create', object: { content: 'hello' } }) },
			directActorIds: [],
		},
	};
}

export function notificationRequest(suffix = ''): NotificationWorkRequest {
	return {
		requestId: `notification${suffix}`, eventId: `event${suffix}`, noteId: `note${suffix}`, actorId: 'actor',
		note: { visibility: 'public', localOnly: false, channelId: null },
		noteGeneration: 1, kind: 'notification.create', schemaVersion: 1,
		occurredAtMs: 1792540800000, notBeforeMs: 1792540800000,
		payload: { candidates: [{ recipientId: 'recipient', type: 'mention' }] },
	};
}
