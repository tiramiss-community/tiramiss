/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createAvatarDecorationAdmin, AvatarDecorationPolicyDenied } from '../modules/avatar-decoration/admin.js';
import { evaluatePolicies, roleAccessFacts, selectApplicableRoles } from '../modules/role/public.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createAvatarDecorationAdminStore } from '../platform/database/avatar-decoration-admin.js';
import { readRoleAuthorizationFacts } from '../platform/database/role-authorization-facts.js';
import { appendModerationLog } from '../platform/database/moderation-log.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createAvatarDecorationAdminHttp(resources: Pick<RuntimeResources, 'avatarDecorations' | 'dataSource' | 'logger' | 'publishInternalEvent'>, config: Pick<RuntimeConfig, 'id'>) {
	const { manager } = resources.dataSource;
	const ids = createIdCodec(config.id);
	const pending = new Set<Promise<void>>();

	function start(work: () => Promise<unknown>) {
		// Source publishers/audit are non-waiting; a failed effect cannot undo a saved decoration.
		const task = Promise.resolve().then(work).then(() => {}, error => {
			try {
				resources.logger.error('avatar-decoration.effect-failed', { error });
			} catch { /* Diagnostics cannot change a saved operation. */ }
		});
		pending.add(task);
		void task.then(() => pending.delete(task));
	}

	const application = createAvatarDecorationAdmin({
		...createAvatarDecorationAdminStore(manager),
		getAll: noCache => resources.avatarDecorations.getAll(noCache),
		newId: ids.newId, createdAtFromId: ids.createdAtFromId,
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
				get canManageAvatarDecorations() {
					return evaluatePolicies({ userId, roles: selectApplicableRoles(facts.roles, facts.assignments, facts.user, atMs), basePolicies: facts.instance.basePolicies, uploadLimitBytes: Infinity }).canManageAvatarDecorations;
				},
			};
		},
		publish: (type, row) => start(() => resources.publishInternalEvent(type, row)),
		audit: entry => start(() => appendModerationLog(manager, entry, ids.newId)),
	});
	const app = createApiEndpoints({
		authenticate: createTokenAuthenticator(manager, resources.logger), logger: resources.logger,
		endpoints: (['create', 'update', 'delete', 'list'] as const).map(operation => ({
			name: `admin/avatar-decorations/${operation}`,
			access: { requireCredential: true, kind: `${operation === 'list' ? 'read' : 'write'}:admin:avatar-decorations` },
			handle: (access, input) => application[operation](access, input, Date.now()),
			errors: error => error instanceof AvatarDecorationPolicyDenied ? {
				message: error.message, code: 'ROLE_PERMISSION_DENIED', kind: 'permission', id: '7f86f06f-7e15-4057-8561-f4b6d4ac755a',
			} : undefined,
		})),
	});
	return { app, async idle() {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	} };
}
