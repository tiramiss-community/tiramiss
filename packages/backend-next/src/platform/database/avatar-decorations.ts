/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAvatarDecoration } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { AvatarDecoration } from '../../modules/avatar-decoration/public.js';

export function createAvatarDecorationReader(manager: EntityManager): () => Promise<AvatarDecoration[]> {
	return () => manager.getRepository(MiAvatarDecoration).find();
}
