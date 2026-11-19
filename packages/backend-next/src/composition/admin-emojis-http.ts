/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createEmojiAdmin, EmojiPolicyDenied } from '../modules/emoji/admin.js';
import { evaluatePolicies, roleAccessFacts, selectApplicableRoles } from '../modules/role/public.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createEmojiAdminReader } from '../platform/database/admin-emojis.js';
import { readRoleAuthorizationFacts } from '../platform/database/role-authorization-facts.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createAdminEmojisHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>, config: Pick<RuntimeConfig, 'id'>) {
	const { manager } = resources.dataSource;
	const ids = createIdCodec(config.id);
	const application = createEmojiAdmin({
		...createEmojiAdminReader(manager), idFromDate: ids.newId,
		async readActor(userId, atMs) {
			const facts = await readRoleAuthorizationFacts(manager, userId, ids.createdAtFromId);
			const access = roleAccessFacts(userId, facts, atMs);
			return {
				isSuspended: access.isSuspended,
				get isModerator() {
					return access.isModerator;
				},
				get isAdministrator() {
					return access.isAdministrator;
				},
				get canManageCustomEmojis() {
					return evaluatePolicies({ userId, roles: selectApplicableRoles(facts.roles, facts.assignments, facts.user, atMs), basePolicies: facts.instance.basePolicies, uploadLimitBytes: Infinity }).canManageCustomEmojis;
				},
			};
		},
	});
	return createApiEndpoints({
		authenticate: createTokenAuthenticator(manager, resources.logger), logger: resources.logger,
		endpoints: ['admin/emoji/list', 'admin/emoji/list-remote', 'v2/admin/emoji/list'].map(name => ({
			name, access: { requireCredential: true, kind: 'read:admin:emoji' },
			handle: (access, input) => name.startsWith('v2/') ? application.listV2(access, input, Date.now()) : application.list(access, input, Date.now(), name.endsWith('list-remote')),
			errors: error => error instanceof EmojiPolicyDenied ? {
				message: error.message, code: 'ROLE_PERMISSION_DENIED', kind: 'permission', id: '7f86f06f-7e15-4057-8561-f4b6d4ac755a',
			} : undefined,
		})),
	});
}
