/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUserProfile } from 'backend-upstream/entities';
import { planFavoriteAchievement, favoriteAchievement } from '../modules/note-personal-state/favorite-achievement.js';
import { PostNotificationPersistence } from '../platform/database/notification/persistence.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { DataSource } from 'typeorm';
import type { Logger } from '../platform/logger.js';
import type { createPostingStream } from '../platform/posting-stream.js';
import type { RuntimeConfig } from '../config/types.js';

export function createFavoriteAchievements(resources: { dataSource: DataSource; postingStream: ReturnType<typeof createPostingStream>; logger: Logger }, config: Pick<RuntimeConfig, 'id'>) {
	const persistence = new PostNotificationPersistence();
	const codec = createIdCodec(config.id);
	const pending = new Set<Promise<void>>();
	const idle = async () => {
		while (pending.size) {
			await Promise.all([...pending]);
		}
	};
	return {
		start(userId: string): void {
			const task = (async () => {
				const now = Date.now();
				const notify = await resources.dataSource.transaction(async manager => {
					const profiles = manager.getRepository(MiUserProfile);
					// Different notes can unlock the same achievement concurrently. Lock before reading to avoid losing existing grants.
					const profile = await profiles.findOneOrFail({ where: { userId }, lock: { mode: 'pessimistic_write' } });
					const plan = planFavoriteAchievement({ achievements: profile.achievements, notificationMode: profile.notificationRecieveConfig?.achievementEarned?.type ?? null }, now);
					if (plan === null) {
						return false;
					}
					await profiles.update(userId, { achievements: plan.achievements as MiUserProfile['achievements'] });
					return plan.notify;
				});
				if (!notify) {
					return;
				}
				const createdAtMs = Date.now();
				const notification = { id: codec.newId(createdAtMs), recipientId: userId, type: 'achievementEarned' as const, achievement: favoriteAchievement, createdAtMs };
				await resources.dataSource.transaction(manager => persistence.save(manager, notification));
				await resources.postingStream.main(userId, 'notification', { id: notification.id, type: notification.type, achievement: favoriteAchievement, createdAt: new Date(createdAtMs).toISOString() });
			})().catch(error => resources.logger.error('favorite-achievement.failed', { userId, error }));
			pending.add(task);
			void task.then(() => pending.delete(task));
		},
		idle,
		close: idle,
	};
}
