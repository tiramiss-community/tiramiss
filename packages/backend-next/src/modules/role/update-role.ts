/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { TransactionRunner } from '../../application/transaction.js';
import type { RoleEvaluation } from './evaluation.js';
import type { RoleActor, RoleChanges, RoleDefinitionsChanged, RolePatch, RoleUpdateScope } from './update-contract.js';
import { selectApplicableRoles } from './applicable-roles.js';
import { ActorSuspended, AdministratorRequired, CredentialScopeDenied, RoleNotFound } from './errors.js';
import { evaluatePrivileges } from './privileges.js';

export function createUpdateRole(dependencies: {
	transactions: TransactionRunner<RoleUpdateScope>;
	changes: RoleChanges;
	clock: () => number;
}) {
	return {
		async updateRole(actor: RoleActor, roleId: string, patch: RolePatch, evaluation: RoleEvaluation): Promise<void> {
			// 呼び出し元による入力の変更を、ロック待機中の操作へ混ぜない。
			const input = structuredClone(patch);
			await dependencies.transactions.run(async (tx) => {
				const facts = await tx.authorizationFacts.read(actor.userId);
				if (facts.user.isSuspended) {
					throw new ActorSuspended();
				}

				const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, evaluation.atMs);
				if (!evaluatePrivileges(actor.userId, facts.instance.rootUserId, roles).isAdministrator) {
					throw new AdministratorRequired();
				}
				if (!actor.credentialGrant.updateRole) {
					throw new CredentialScopeDenied();
				}

				const before = await tx.roles.getForUpdate(roleId);
				if (before === null) {
					throw new RoleNotFound();
				}
				const occurredAtMs = dependencies.clock();
				const after = await tx.roles.savePatch(roleId, input, occurredAtMs);
				await tx.auditLogs.appendRoleUpdate({ actorId: actor.userId, roleId, before, after, occurredAtMs });
			});

			const change: RoleDefinitionsChanged = { kind: 'role-definitions-changed', roleId };
			// commit済みの更新は、メモの終了や通知障害で失敗へ戻せない。
			try {
				evaluation.invalidate({ kind: 'roles' });
			} catch {}
			try {
				dependencies.changes.invalidateLocal(change);
			} catch {}
			try {
				await dependencies.changes.publish(change);
			} catch {}
		},
	};
}
