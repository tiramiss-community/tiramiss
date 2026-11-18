/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull, Not } from 'typeorm';
import { MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';

export function createUserChartCounts(manager: EntityManager) {
	return async () => {
		const users = manager.getRepository(MiUser);
		const [local, remote] = await Promise.all([users.countBy({ host: IsNull() }), users.countBy({ host: Not(IsNull()) })]);
		return { local, remote };
	};
}
