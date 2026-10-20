/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiMeta, MiUser } from 'backend-upstream/entities';
import { createIdCodec } from '../../src/platform/id-codec.js';
import type { DataSource } from 'typeorm';
import type { RoleFactsReader } from '../../src/modules/role/public.js';

// User/Metaの更新機能は初期範囲外。材料は実DBから読み、Role材料だけ既存の共有キャッシュを通す。
export function evaluationReader(source: DataSource, materials: Pick<RoleFactsReader, 'readRoles' | 'readAssignments'>): RoleFactsReader {
	return {
		readRoles: materials.readRoles,
		readAssignments: materials.readAssignments,
		readUserRoleFacts: async id => {
			const row = await source.getRepository(MiUser).findOneByOrFail({ id });
			return {
				userId: row.id, host: row.host, createdAtMs: createIdCodec('aidx').createdAtFromId(row.id),
				isSuspended: row.isSuspended, isLocked: row.isLocked, isBot: row.isBot, isCat: row.isCat,
				isExplorable: row.isExplorable, followersCount: row.followersCount,
				followingCount: row.followingCount, notesCount: row.notesCount,
			};
		},
		readInstanceRoleFacts: async () => {
			const row = await source.getRepository(MiMeta).findOneByOrFail({});
			return { rootUserId: row.rootUserId, basePolicies: structuredClone(row.policies) };
		},
	};
}
