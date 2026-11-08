/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { requireCredential } from '../access/public.js';
import { RoleNotFound } from './errors.js';
import { roleAccessFacts } from './access.js';
import { prepareRoleInput } from './input.js';
import type { AccessRequest } from '../access/public.js';
import type { RoleChanges, RoleDefinitionsChanged, RoleUpdateScope } from './update-contract.js';
import type { RoleEvaluation } from './evaluation.js';
import type { TransactionRunner } from '../../application/transaction.js';

export function createUpdateRole(dependencies: {
	transactions: TransactionRunner<RoleUpdateScope>;
	changes: RoleChanges;
	clock: () => number;
}) {
	return {
		async updateRole(access: AccessRequest, rawInput: unknown, evaluation: RoleEvaluation): Promise<void> {
			// 呼び出し元による入力の変更を、ロック待機中の操作へ混ぜない。
			const readInput = prepareRoleInput(rawInput, 'update');
			const actor = requireCredential(access.credential);
			// 資格の確認は、更新と同じトランザクションで読んだ現在の事実で行う。
			const changedRoleId = await dependencies.transactions.run(async (tx) => {
				const facts = await tx.authorizationFacts.read(actor.userId);
				access.authorize(roleAccessFacts(actor.userId, facts, evaluation.atMs));

				const { roleId, patch } = readInput();
				const before = await tx.roles.getForUpdate(roleId);
				if (before === null) {
					throw new RoleNotFound();
				}
				const occurredAtMs = dependencies.clock();
				const after = await tx.roles.savePatch(roleId, patch, occurredAtMs);
				await tx.auditLogs.appendRoleUpdate({ actorId: actor.userId, roleId, before, after, occurredAtMs });
				return roleId;
			});

			const change: RoleDefinitionsChanged = { kind: 'role-definitions-changed', roleId: changedRoleId };
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
