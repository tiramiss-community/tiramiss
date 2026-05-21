/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { QUEUE, type QueueType } from '@/queue/const.js';
import { deliverQueue } from '@/queue/jobs/definitions/deliver.js';
import { inboxQueue } from '@/queue/jobs/definitions/inbox.js';
import { systemQueue } from '@/queue/jobs/definitions/system.js';
import { endedPollNotificationQueue, postScheduledNoteQueue } from '@/queue/jobs/definitions/misc.js';
import { dbQueue } from '@/queue/jobs/definitions/db.js';
import { relationshipQueue } from '@/queue/jobs/definitions/relationship.js';
import { objectStorageQueue } from '@/queue/jobs/definitions/objectStorage.js';
import { systemWebhookDeliverQueue, userWebhookDeliverQueue } from '@/queue/jobs/definitions/webhook.js';
import { notePostQueue } from '@/queue/jobs/definitions/note.js';
import { noteDeleteQueue } from '@/queue/jobs/definitions/noteDelete.js';
import { reactionDeliverQueue } from '@/queue/jobs/definitions/reactionDeliver.js';
import { notePiningDeliverQueue } from '@/queue/jobs/definitions/notePiningDeliver.js';
import { instanceFollowStatsUpdateQueue } from '@/queue/jobs/definitions/instanceFollowStatsUpdate.js';
import type { QueueDefinition } from '@mokurokujs/core';

const definitionsByType: Record<QueueType, QueueDefinition> = {
	[QUEUE.DELIVER]: deliverQueue,
	[QUEUE.INBOX]: inboxQueue,
	[QUEUE.SYSTEM]: systemQueue,
	[QUEUE.ENDED_POLL_NOTIFICATION]: endedPollNotificationQueue,
	[QUEUE.POST_SCHEDULED_NOTE]: postScheduledNoteQueue,
	[QUEUE.DB]: dbQueue,
	[QUEUE.RELATIONSHIP]: relationshipQueue,
	[QUEUE.OBJECT_STORAGE]: objectStorageQueue,
	[QUEUE.USER_WEBHOOK_DELIVER]: userWebhookDeliverQueue,
	[QUEUE.SYSTEM_WEBHOOK_DELIVER]: systemWebhookDeliverQueue,
	[QUEUE.NOTE_POST]: notePostQueue,
	[QUEUE.NOTE_DELETE]: noteDeleteQueue,
	[QUEUE.REACTION_DELIVER]: reactionDeliverQueue,
	[QUEUE.NOTE_PINING_DELIVER]: notePiningDeliverQueue,
	[QUEUE.INSTANCE_FOLLOW_STATS_UPDATE]: instanceFollowStatsUpdateQueue,
};

export function queueDefinitionFromType(queueType: QueueType): QueueDefinition {
	return definitionsByType[queueType];
}
