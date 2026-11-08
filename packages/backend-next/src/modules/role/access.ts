/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { selectApplicableRoles } from './applicable-roles.js';
import { evaluatePrivileges } from './privileges.js';
import type { AccessFacts } from '../access/public.js';
import type { RoleAuthorizationFacts } from './update-contract.js';

/**
 * 共通gateへ渡す呼び出し元の事実。ロールの評価は凍結の判定後に初めて行う。
 * 凍結済みの呼び出し元へ、条件式の評価失敗を403より先に返さないため。
 */
export function roleAccessFacts(userId: string, facts: RoleAuthorizationFacts, atMs: number): AccessFacts {
	let privileges: ReturnType<typeof evaluatePrivileges> | undefined;
	const evaluate = () => privileges ??= evaluatePrivileges(userId, facts.instance.rootUserId,
		selectApplicableRoles(facts.roles, facts.assignments, facts.user, atMs));
	return {
		isSuspended: facts.user.isSuspended,
		get isModerator() {
			return evaluate().isModerator;
		},
		get isAdministrator() {
			return evaluate().isAdministrator;
		},
	};
}
