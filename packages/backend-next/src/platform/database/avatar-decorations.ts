/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAvatarDecoration } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { AdminAvatarDecoration } from '../../modules/avatar-decoration/admin.js';

export function createAvatarDecorationReader(manager: EntityManager): () => Promise<AdminAvatarDecoration[]> {
	return () => manager.getRepository(MiAvatarDecoration).find();
}
