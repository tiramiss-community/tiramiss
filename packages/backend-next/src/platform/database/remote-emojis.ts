/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In } from 'typeorm';
import { MiEmoji } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { RemoteEmoji, RemoteEmojiRepository } from '../../modules/federation/public.js';

function facts(row: MiEmoji): RemoteEmoji {
	return { id: row.id, name: row.name, host: row.host, uri: row.uri, originalUrl: row.originalUrl, publicUrl: row.publicUrl, updatedAt: row.updatedAt, aliases: [...row.aliases], license: row.license };
}

export function createRemoteEmojiRepository(manager: EntityManager): RemoteEmojiRepository {
	const repository = manager.getRepository(MiEmoji);
	return {
		async find(host, names) {
			return (await repository.findBy({ host, name: In(names) })).map(facts);
		},
		async update(host, name, patch) {
			await repository.update({ host, name }, patch);
		},
		async findOne(host, name) {
			const row = await repository.findOneBy({ host, name });
			return row ? facts(row) : null;
		},
		async insert(input) {
			const result = await repository.insert(input);
			return facts(await repository.findOneOrFail({ where: result.identifiers[0] }));
		},
	};
}
