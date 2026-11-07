/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readMeta } from './meta.js';
import type { EntityManager } from 'typeorm';
import type { HashtagMention, HashtagRankingSettings } from '../../modules/note/public.js';

export async function readHashtagRankingSettings(manager: EntityManager): Promise<HashtagRankingSettings> {
	const meta = await readMeta(manager);
	return { hiddenTags: meta.hiddenTags, sensitiveWords: meta.sensitiveWords };
}

export function createNoteHashtagWriter(manager: EntityManager, newId: () => string) {
	return {
		async mention(input: HashtagMention): Promise<void> {
			const ids = input.userHost == null ? 'mentionedLocalUserIds' : 'mentionedRemoteUserIds';
			const count = input.userHost == null ? 'mentionedLocalUsersCount' : 'mentionedRemoteUsersCount';
			const append = (column: string) => `CASE WHEN NOT ("hashtag"."${column}" @> ARRAY[$2::varchar]) THEN array_append("hashtag"."${column}", $2) ELSE "hashtag"."${column}" END`;
			const increment = (column: string, total: string) => `CASE WHEN NOT ("hashtag"."${column}" @> ARRAY[$2::varchar]) THEN "hashtag"."${total}" + 1 ELSE "hashtag"."${total}" END`;
			// TypeORM 1.1.1 orUpdate only accepts overwrite columns; conditional array/count
			// expressions need this narrow parameterized conflict statement to retain source atomicity.
			await manager.query(`INSERT INTO "hashtag" ("id", "name", "mentionedUserIds", "mentionedUsersCount", "${ids}", "${count}")
				VALUES ($3, $1, ARRAY[$2], 1, ARRAY[$2], 1)
				ON CONFLICT ("name") DO UPDATE SET
				"mentionedUserIds" = ${append('mentionedUserIds')},
				"mentionedUsersCount" = ${increment('mentionedUserIds', 'mentionedUsersCount')},
				"${ids}" = ${append(ids)}, "${count}" = ${increment(ids, count)}`, [input.tag, input.userId, newId()]);
		},
	};
}
