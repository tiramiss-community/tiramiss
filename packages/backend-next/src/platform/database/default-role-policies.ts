/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiMeta } from 'backend-upstream/entities';
import { readMeta } from './meta.js';
import type { DataSource } from 'typeorm';
export async function replaceDefaultRolePolicies(source: DataSource, policies: Record<string, unknown>) {
	return source.transaction(async (manager) => {
		const before = await readMeta(manager);
		// QueryDeepPartialEntity cannot express arbitrary policy JSON values.
		await manager.getRepository(MiMeta).createQueryBuilder().update()
			.set({ policies: () => 'CAST(:policies AS jsonb)' }).where('id = :id', { id: before.id })
			.setParameter('policies', JSON.stringify(policies)).execute();
		return { before, after: await readMeta(manager) };
	});
}
