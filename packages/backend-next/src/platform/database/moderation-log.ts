/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiModerationLog } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { ModerationLogEntry } from '../../modules/audit/public.js';

/**
 * moderation_log への唯一の書き込み口。呼び出し元の manager で書くため、トランザクション内外は呼び出し元が決める。
 * `info` は TypeORM の jsonb 保存と同じく `JSON.stringify` で直列化する（Date は ISO 文字列、undefined のキーは除く）。
 */
export async function appendModerationLog(
	manager: EntityManager,
	entry: ModerationLogEntry,
	newId: (occurredAtMs: number) => string,
): Promise<void> {
	// QueryDeepPartialEntity は任意の JSONB 値を表せないため、JSON 値だけを parameter として渡す。
	await manager.getRepository(MiModerationLog).createQueryBuilder().insert().values({
		id: newId(entry.occurredAtMs), userId: entry.actorId, type: entry.type, info: () => 'CAST(:info AS jsonb)',
	}).setParameter('info', JSON.stringify(entry.info ?? {})).execute();
}
