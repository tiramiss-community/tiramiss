/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { domainToASCII } from 'node:url';
import { MiDriveFile, MiDriveFolder } from 'backend-upstream/entities';
import { evaluatePolicies, selectApplicableRoles } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import { createDriveFileStore, driveStoredFile } from './drive-files.js';
import type { EntityManager, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { DriveListPorts, DriveUsageSelection } from '../../modules/drive/list-usage.js';
import type { PaginationPlan } from '../../modules/shared/pagination.js';
import type { DriveFileMediaOptions } from '../../modules/drive/files-public.js';

export function createDriveUsageReader(manager: EntityManager) {
	return async (selection: DriveUsageSelection): Promise<number> => {
		const query = manager.getRepository(MiDriveFile).createQueryBuilder('file').where('file.isLink = FALSE');
		if ('userId' in selection) {
			query.andWhere('file.userId = :userId', { userId: selection.userId });
		} else if ('host' in selection) {
			query.andWhere('file.userHost = :host', { host: domainToASCII(selection.host.toLowerCase()) });
		} else {
			query.andWhere(selection.origin === 'local' ? 'file.userHost IS NULL' : 'file.userHost IS NOT NULL');
		}
		const result = await query.select('SUM(file.size)', 'sum').getRawOne<{ sum: string | null }>();
		return Number.parseInt(result?.sum ?? '', 10) || 0;
	};
}

function paginate<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, page: PaginationPlan) {
	if (page.sinceId) {
		query.andWhere(`${query.alias}.id > :sinceId`, { sinceId: page.sinceId });
	}
	if (page.untilId) {
		query.andWhere(`${query.alias}.id < :untilId`, { untilId: page.untilId });
	}
	return query.orderBy(`${query.alias}.id`, page.order);
}

export function createDriveListStore(manager: EntityManager, media: DriveFileMediaOptions, idFromDate: (date: number) => string): DriveListPorts {
	const fileStore = createDriveFileStore(manager, media);
	return {
		media, idFromDate, readActor: fileStore.readActor, preload: fileStore.preload,
		readUsage: createDriveUsageReader(manager),
		async readCapacityMb(id, now) {
			const facts = await readRoleAuthorizationFacts(manager, id, media.createdAtFromId);
			const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, now);
			return evaluatePolicies({ userId: id, roles, basePolicies: facts.instance.basePolicies, uploadLimitBytes: 0 }).driveCapacityMb;
		},
		async listFiles(input, page, userId, mode) {
			const query = paginate(manager.getRepository(MiDriveFile).createQueryBuilder('file'), page);
			if (mode !== 'admin') {
				query.andWhere('file.userId = :userId', { userId });
				if (mode === 'files') {
					if (input.folderId) {
						query.andWhere('file.folderId = :folderId', { folderId: input.folderId });
					} else {
						query.andWhere('file.folderId IS NULL');
					}
				}
			} else if (input.userId) {
				query.andWhere('file.userId = :userId', { userId: input.userId });
			} else {
				if (input.origin === 'local') {
					query.andWhere('file.userHost IS NULL');
				} else if (input.origin === 'remote') {
					query.andWhere('file.userHost IS NOT NULL');
				}
				if (input.hostname) {
					query.andWhere('file.userHost = :hostname', { hostname: input.hostname });
				}
			}
			if (input.type) {
				query.andWhere(input.type.endsWith('/*') ? 'file.type like :type' : 'file.type = :type', { type: input.type.endsWith('/*') ? input.type.replace('/*', '/') + '%' : input.type });
			}
			if (mode === 'files' && input.sort) {
				const column = input.sort.slice(1) === 'createdAt' ? 'id' : input.sort.slice(1);
				query.orderBy(`file.${column}`, input.sort.startsWith('+') ? 'DESC' : 'ASC');
			}
			return (await query.limit(input.limit).getMany()).map(driveStoredFile);
		},
		async listFolders(input, page, userId) {
			const query = paginate(manager.getRepository(MiDriveFolder).createQueryBuilder('folder'), page).andWhere('folder.userId = :userId', { userId });
			if (input.folderId) {
				query.andWhere('folder.parentId = :parentId', { parentId: input.folderId });
			} else {
				query.andWhere('folder.parentId IS NULL');
			}
			return (await query.limit(input.limit).getMany()).map(({ id, name, parentId, userId: owner }) => ({ id, name, parentId, userId: owner }));
		},
	};
}
