/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { domainToASCII } from 'node:url';
import { In } from 'typeorm';
import { MiEmoji, MiRole } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { EmojiAdminPorts } from '../../modules/emoji/admin.js';

const likeEscape = (text: string) => text.replace(/([\\%_])/g, '\\$1');
export function createEmojiAdminReader(manager: EntityManager): Pick<EmojiAdminPorts, 'list' | 'listV2' | 'roles'> {
	const repository = manager.getRepository(MiEmoji);
	return {
		async list(input, page, remote) {
			const builder = repository.createQueryBuilder('emoji');
			if (page.sinceId) {
				builder.andWhere('emoji.id > :sinceId', { sinceId: page.sinceId });
			}
			if (page.untilId) {
				builder.andWhere('emoji.id < :untilId', { untilId: page.untilId });
			}
			builder.orderBy('emoji.id', remote ? 'DESC' : page.order);
			if (remote) {
				if (input.host == null) {
					builder.andWhere('emoji.host IS NOT NULL');
				} else {
					builder.andWhere('emoji.host = :host', { host: domainToASCII(input.host.toLowerCase()) });
				}
				if (input.query) {
					builder.andWhere('emoji.name LIKE :query', { query: `%${likeEscape(input.query)}%` });
				}
				return builder.limit(input.limit).getMany();
			}
			builder.andWhere('emoji.host IS NULL');
			if (!input.query) {
				return builder.limit(input.limit).getMany();
			}
			// The legacy callback filters the full cursor-bounded set before taking limit + 1.
			const tokens = input.query.match(/\:([a-z0-9_]*)\:/g);
			return (await builder.getMany()).filter(row => tokens
				? tokens.includes(`:${row.name}:`)
				: row.name.includes(input.query!) || row.aliases.some(alias => alias.includes(input.query!)) || row.category?.includes(input.query!)).slice(0, input.limit + 1);
		},
		async listV2(input, bounds) {
			const builder = repository.createQueryBuilder('emoji');
			const query = input.query;
			if (query) {
				for (const [field, operator] of [['updatedAtFrom', '>='], ['updatedAtTo', '<=']] as const) {
					if (query[field]) {
						builder.andWhere(`CAST(emoji.updatedAt AS DATE) ${operator} :${field}`, { [field]: query[field] });
					}
				}
				if (query.hostType === 'local') {
					builder.andWhere('emoji.host IS NULL');
				} else if (query.hostType === 'remote' && !query.host) {
					builder.andWhere('emoji.host IS NOT NULL');
				}
				for (const field of ['name', 'host', 'uri', 'publicUrl', 'type', 'aliases', 'category', 'license'] as const) {
					const value = query[field];
					if (!value || (field === 'host' && query.hostType !== 'remote')) {
						continue;
					}
					const words = value.split(/\s/).filter(word => word.length > 0).map(word => `%${likeEscape(word)}%`);
					if (field === 'aliases') {
						builder.andWhere(`EXISTS (SELECT 1 FROM unnest(emoji.aliases) AS alias WHERE alias ~~ ANY(ARRAY[:...${field}]))`, { [field]: words });
					} else {
						builder.andWhere(`emoji.${field} ~~ ANY(ARRAY[:...${field}])`, { [field]: words });
					}
				}
				for (const field of ['isSensitive', 'localOnly'] as const) {
					if (query[field] != null) {
						builder.andWhere(`emoji.${field} = :${field}`, { [field]: query[field] });
					}
				}
				if (query.roleIds?.length) {
					builder.andWhere('emoji.roleIdsThatCanBeUsedThisEmojiAsReaction && ARRAY[:...roleIds]::VARCHAR[]', { roleIds: query.roleIds });
				}
			}
			if (bounds.sinceId) {
				builder.andWhere('emoji.id > :sinceId', { sinceId: bounds.sinceId });
			}
			if (bounds.untilId) {
				builder.andWhere('emoji.id < :untilId', { untilId: bounds.untilId });
			}
			for (const key of input.sortKeys.length ? input.sortKeys : ['-id']) {
				builder.addOrderBy(`emoji.${key.replace(/^[+-]/, '')}`, key.startsWith('-') ? 'DESC' : 'ASC');
			}
			if (input.page) {
				builder.skip((input.page - 1) * input.limit);
			}
			const [emojis, count] = await builder.take(input.limit).getManyAndCount();
			return { emojis, count: count > input.limit ? emojis.length : count, allCount: count, allPages: Math.ceil(count / input.limit) };
		},
		roles: ids => manager.getRepository(MiRole).findBy({ id: In(ids) }),
	};
}
