/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { entities, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { createRoleShowReader } from '../../../src/platform/database/role-show.js';

const source = new DataSource({ type: 'postgres', entities });
const atMs = Date.parse('2026-11-17T00:00:00Z');
beforeAll(async () => {
	await (source as unknown as { buildMetadatas(): Promise<void>; }).buildMetadatas();
});
afterEach(() => vi.restoreAllMocks());

test.each([0, 1, 65535])('public list with %i roles keeps assignment binds within a constant size', async count => {
	const roles = source.getRepository(MiRole);
	const rows = Array.from({ length: count }, (_, index) => roles.create({
		id: `role${index}`, name: `role${index}`, description: '', color: null, iconUrl: null,
		target: 'manual', condFormula: {}, policies: {}, isPublic: true, isExplorable: true,
		isModerator: false, isAdministrator: false, asBadge: false, preserveAssignmentOnMoveAccount: false,
		canEditMembersByModerator: false, displayOrder: 0, updatedAt: new Date(atMs), lastUsedAt: new Date(atMs),
	}));
	vi.spyOn(roles, 'findBy').mockResolvedValue(rows);
	const assignments = source.getRepository(MiRoleAssignment);
	const query = assignments.createQueryBuilder('assignment');
	const parameterSets: unknown[][] = [];
	vi.spyOn(query, 'getRawMany').mockImplementation(async () => {
		parameterSets.push(query.getQueryAndParameters()[1]);
		return [];
	});
	vi.spyOn(assignments, 'createQueryBuilder').mockReturnValue(query);

	const result = await createRoleShowReader(source.manager, () => atMs).listPublic(atMs);
	expect(result).toHaveLength(count);
	if (count === 0) {
		expect(parameterSets).toHaveLength(0);
	} else {
		expect(parameterSets).toHaveLength(1);
		expect(parameterSets[0].length).toBe(2);
		expect(parameterSets[0][0]).toEqual(rows.map(row => row.id));
		expect(parameterSets[0][1]).toEqual(new Date(atMs));
	}
});
