/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createNotifyPollEnded } from '../modules/notification/public.js';
import { createNotificationTransactions, createPollEndedReader } from '../platform/database/poll-ended.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { PollEndedJob } from '../platform/job-queue/ended-poll-notification.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

/** 投票終了ジョブ 1 件を処理する関数を組み立てる。 */
export function createPollEndedHandler(resources: Pick<RuntimeResources, 'dataSource' | 'logger'> & Partial<Pick<RuntimeResources, 'postingNotifications'>>, config: Pick<RuntimeConfig, 'id'>) {
	const codec = createIdCodec(config.id);
	const { notifyPollEnded } = createNotifyPollEnded({
		...createPollEndedReader(resources.dataSource.manager),
		notifications: createNotificationTransactions(resources.dataSource),
		afterSaved: resources.postingNotifications?.afterNotificationSaved,
		newId: codec.newId,
		currentTime: Date.now,
	});

	return async (job: PollEndedJob): Promise<void> => {
		const result = await notifyPollEnded({ noteId: job.noteId });
		for (const failure of result.failures) {
			resources.logger.error('poll-ended.notification-failed', { noteId: job.noteId, recipientId: failure.recipientId, error: failure.error });
		}
	};
}
