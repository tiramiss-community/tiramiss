/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiHashtag } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { UserHashtagChange } from '../../modules/federation/public.js';

export function createUserHashtagWriter(manager: EntityManager, newId: () => string) {
	return {
		async change(input: UserHashtagChange): Promise<void> {
			const ids = input.userHost === null ? 'attachedLocalUserIds' : 'attachedRemoteUserIds';
			const count = input.userHost === null ? 'attachedLocalUsersCount' : 'attachedRemoteUsersCount';
			if (input.attached) {
				const append = (column: string) => `CASE WHEN NOT ("hashtag"."${column}" @> ARRAY[$2::varchar]) THEN array_append("hashtag"."${column}", $2) ELSE "hashtag"."${column}" END`;
				const increment = (column: string, total: string) => `CASE WHEN NOT ("hashtag"."${column}" @> ARRAY[$2::varchar]) THEN "hashtag"."${total}" + 1 ELSE "hashtag"."${total}" END`;
				// TypeORM 1.1.1 InsertQueryBuilder.orUpdate accepts overwrite columns only (no
				// onConflict expression API). Conditional array/count upsert requires this narrow SQL.
				await manager.query(`INSERT INTO "hashtag" ("id", "name", "attachedUserIds", "attachedUsersCount", "${ids}", "${count}")
					VALUES ($3, $1, ARRAY[$2], 1, ARRAY[$2], 1)
					ON CONFLICT ("name") DO UPDATE SET
					"attachedUserIds" = ${append('attachedUserIds')},
					"attachedUsersCount" = ${increment('attachedUserIds', 'attachedUsersCount')},
					"${ids}" = ${append(ids)}, "${count}" = ${increment(ids, count)}`, [input.tag, input.userId, newId()]);
				return;
			}
			const decrement = (column: string, total: string) => () => `CASE WHEN ("${column}" @> ARRAY[:userId::varchar]) THEN "${total}" - 1 ELSE "${total}" END`;
			await manager.createQueryBuilder().update(MiHashtag).set({
				attachedUserIds: () => 'array_remove("attachedUserIds", :userId)',
				attachedUsersCount: decrement('attachedUserIds', 'attachedUsersCount'),
				[ids]: () => `array_remove("${ids}", :userId)`,
				[count]: decrement(ids, count),
			}).where('name = :tag', { tag: input.tag }).setParameter('userId', input.userId).execute();
		},
	};
}
