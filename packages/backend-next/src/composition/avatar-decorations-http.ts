/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createAvatarDecorationsApi } from '../http/avatar-decorations-api.js';
import { createPublicAvatarDecorations } from '../modules/avatar-decoration/public.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import type { RuntimeResources } from './create-runtime.js';

export function createAvatarDecorationsHttp(resources: Pick<RuntimeResources, 'avatarDecorations' | 'roleMaterials' | 'dataSource' | 'logger'>) {
	return createAvatarDecorationsApi(createPublicAvatarDecorations({
		getAll: noCache => resources.avatarDecorations.getAll(noCache),
		readRoles: () => resources.roleMaterials.readRoles(),
	}), {
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		logger: resources.logger,
	});
}
