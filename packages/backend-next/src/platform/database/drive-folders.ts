/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull } from 'typeorm';
import { MiDriveFile, MiDriveFolder } from 'backend-upstream/entities';
import { evaluatePolicies, evaluatePrivileges, selectApplicableRoles } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import type { EntityManager } from 'typeorm';
import type { DriveFolderPorts, DriveFolderRow } from '../../modules/drive/folders.js';
export function createDriveFolderStore(manager: EntityManager, createdAtFromId: (id: string) => number): Pick<DriveFolderPorts, 'readActor' | 'readFolder' | 'findFolders' | 'readCounts' | 'insertFolder' | 'updateFolder' | 'deleteFolder'> {
	const folders = manager.getRepository(MiDriveFolder);
	const files = manager.getRepository(MiDriveFile);
	const row = (folder: MiDriveFolder): DriveFolderRow => ({ id: folder.id, userId: folder.userId, name: folder.name, parentId: folder.parentId });
	return {
		async readActor(id, now) {
			const facts = await readRoleAuthorizationFacts(manager, id, createdAtFromId);
			const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, now);
			const policies = evaluatePolicies({ userId: id, roles, basePolicies: facts.instance.basePolicies, uploadLimitBytes: 0 });
			return { isSuspended: facts.user.isSuspended, ...evaluatePrivileges(id, facts.instance.rootUserId, roles), rateLimitFactor: policies.rateLimitFactor };
		},
		async readFolder(id, userId) {
			const folder = await folders.findOneBy({ id, ...(userId === undefined ? {} : { userId }) });
			return folder ? row(folder) : null;
		},
		async findFolders(name, parentId, userId) {
			return (await folders.findBy({ name, userId, parentId: parentId ?? IsNull() })).map(row);
		},
		async readCounts(id) {
			const [foldersCount, filesCount] = await Promise.all([folders.countBy({ parentId: id }), files.countBy({ folderId: id })]);
			return { foldersCount, filesCount };
		},
		async insertFolder(folder) {
			await folders.insert(folder);
		},
		async updateFolder(folder) {
			await folders.update(folder.id, { name: folder.name, parentId: folder.parentId });
		},
		async deleteFolder(id) {
			await folders.delete(id);
		},
	};
}
