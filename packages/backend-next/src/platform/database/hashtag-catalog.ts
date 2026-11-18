/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiHashtag } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { HashtagCatalogReader } from '../../modules/hashtag/catalog.js';

export function createHashtagCatalogReader(manager: EntityManager): HashtagCatalogReader {
	const repository = manager.getRepository(MiHashtag);
	return {
		async list(input) {
			const query = repository.createQueryBuilder('tag');
			if (input.attachedToUserOnly) {
				query.andWhere('tag.attachedUsersCount != 0');
			}
			if (input.attachedToLocalUserOnly) {
				query.andWhere('tag.attachedLocalUsersCount != 0');
			}
			if (input.attachedToRemoteUserOnly) {
				query.andWhere('tag.attachedRemoteUsersCount != 0');
			}
			const column = `${input.sort.slice(1)}Count`;
			return query.select(['tag.name', 'tag.mentionedUsersCount', 'tag.mentionedLocalUsersCount', 'tag.mentionedRemoteUsersCount', 'tag.attachedUsersCount', 'tag.attachedLocalUsersCount', 'tag.attachedRemoteUsersCount'])
				.orderBy(`tag.${column}`, input.sort[0] === '+' ? 'DESC' : 'ASC').limit(input.limit).getMany();
		},
		async search(input) {
			const prefix = input.query.replace(/([\\%_])/g, '\\$1');
			const rows = await repository.createQueryBuilder('tag').where('tag.name like :q', { q: `${prefix}%` })
				.orderBy('tag.mentionedLocalUsersCount', 'DESC').groupBy('tag.id').limit(input.limit).offset(input.offset).getMany();
			return rows.map(row => row.name);
		},
		find: name => repository.findOneBy({ name }),
	};
}
