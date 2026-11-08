/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAccessToken, MiApp, MiUser } from 'backend-upstream/entities';
import { AuthenticationFailed } from '../../modules/access/public.js';
import type { EntityManager } from 'typeorm';
import type { AccessCredential } from '../../modules/access/public.js';
import type { Logger } from '../logger.js';

export interface AuthenticatedCaller {
	credential: AccessCredential;
	isSuspended: boolean;
}

export type TokenAuthenticator = (token: string | null | undefined) => Promise<AuthenticatedCaller | null>;

export function createTokenAuthenticator(manager: EntityManager, logger: Logger): TokenAuthenticator {
	return async token => {
		// 空文字列は匿名ではなく、照合に失敗するトークンとして扱う（本家と同じ`== null`判定）。
		if (token == null) {
			return null;
		}

		if (token.length === 16) {
			const user = await manager.getRepository(MiUser).findOneBy({ token });
			if (user === null) {
				throw new AuthenticationFailed();
			}
			return { credential: { userId: user.id, native: true }, isSuspended: user.isSuspended };
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
		return { credential: { userId: user.id, native: false, permissions: new Set(permission) }, isSuspended: user.isSuspended };
	};
}
