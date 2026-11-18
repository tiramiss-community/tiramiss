/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAvatarDecoration } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { AvatarDecorationAdminPorts } from '../../modules/avatar-decoration/admin.js';

export function createAvatarDecorationAdminStore(manager: EntityManager): Pick<AvatarDecorationAdminPorts, 'insert' | 'find' | 'update' | 'delete'> {
	const repository = () => manager.getRepository(MiAvatarDecoration);
	return {
		async insert(row) {
			await repository().insert(row);
			return repository().findOneByOrFail({ id: row.id });
		},
		find: id => repository().findOneByOrFail({ id }),
		async update(id, patch) {
			await repository().update(id, patch);
			return repository().findOneByOrFail({ id });
		},
		async delete(id) {
			await repository().delete({ id });
		},
	};
}
