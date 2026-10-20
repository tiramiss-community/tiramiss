/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAccessToken, MiApp, MiUser } from 'backend-upstream/entities';
import { AuthenticationFailed, CredentialRequired } from '../../http/authentication-error.js';
import type { EntityManager } from 'typeorm';
import type { RoleActor } from '../../modules/role/public.js';
import type { Logger } from '../logger.js';

export function createTokenAuthenticator(manager: EntityManager, logger: Logger) {
	return async (token: string | null | undefined): Promise<RoleActor> => {
		if (token == null) {
			throw new CredentialRequired();
		}
		if (token.length === 16) {
			const user = await manager.getRepository(MiUser).findOneBy({ token });
			if (user === null) {
				throw new AuthenticationFailed();
			}
			return { userId: user.id, credentialGrant: { readRole: true, updateRole: true } };
		}

		const accessToken = await manager.getRepository(MiAccessToken).findOne({ where: [{ hash: token.toLowerCase() }, { token }] });
		if (accessToken === null) {
			throw new AuthenticationFailed();
		}
		const user = await manager.getRepository(MiUser).findOneBy({ id: accessToken.userId });
		if (user === null) {
			throw new AuthenticationFailed();
		}
		const permission = accessToken.appId
			? (await manager.getRepository(MiApp).findOneByOrFail({ id: accessToken.appId })).permission
			: accessToken.permission;
		// 使用日時の観測に失敗しても、認証済みの資格や業務更新を失敗へ変えない。
		try {
			await manager.getRepository(MiAccessToken).update(accessToken.id, { lastUsedAt: new Date() });
		} catch (error) {
			logger.error('credential-usage.failed', { error });
		}
		return { userId: user.id, credentialGrant: {
			readRole: permission.includes('read:admin:roles'), updateRole: permission.includes('write:admin:roles'),
		} };
	};
}
