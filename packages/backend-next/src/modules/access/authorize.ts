/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { allowsPermission } from './credential.js';
import { AccessDenied } from './errors.js';
import type { AccessCredential } from './credential.js';

/** 本家endpoint metaのうち、共通gateが判定する項目。 */
export interface AccessRequirement {
	readonly requireCredential?: boolean;
	readonly requireModerator?: boolean;
	readonly requireAdmin?: boolean;
	readonly kind?: string;
}

/** 呼び出し元の現在の状態。rootユーザーは両方のロール判定を満たすものとして渡す。 */
export interface AccessFacts {
	readonly isSuspended: boolean;
	readonly isModerator: boolean;
	readonly isAdministrator: boolean;
}

/**
 * endpointの要件を束縛した認可の窓口。資格必須のendpointでは、UseCaseが事実を読んだ位置
 * （必要なら同じトランザクション内）で`authorize`を呼ぶ。要件の定義はendpoint側に置き、判定の位置だけをUseCaseが決める。
 * 資格不要のendpointは凍結・ロールを判定しないため、作成時に判定を終える。
 */
export interface AccessRequest {
	readonly credential: AccessCredential | null;
	authorize(facts: AccessFacts): AccessCredential;
}

export function requiresCredential(requirement: AccessRequirement): boolean {
	return requirement.requireCredential === true || requirement.requireModerator === true || requirement.requireAdmin === true;
}

export function requireCredential(credential: AccessCredential | null): AccessCredential {
	if (credential === null) {
		throw new AccessDenied('CREDENTIAL_REQUIRED');
	}
	return credential;
}

/**
 * 本家ApiCallServiceと同じ順序（資格→凍結→ロール→scope）で判定する。
 * 事実の取得は呼び出し側が行い、ここではDBやキャッシュを読まない。
 */
export function authorizeAccess(requirement: AccessRequirement, credential: AccessCredential, facts: AccessFacts): AccessCredential {
	const credentialRequired = requiresCredential(requirement);
	if (credentialRequired && facts.isSuspended) {
		throw new AccessDenied('YOUR_ACCOUNT_SUSPENDED');
	}

	if (requirement.requireModerator && !facts.isModerator) {
		throw new AccessDenied('MODERATOR_REQUIRED');
	}
	if (requirement.requireAdmin && !facts.isAdministrator) {
		throw new AccessDenied('ADMINISTRATOR_REQUIRED');
	}

	authorizeScope(requirement, credential);
	return credential;
}

function authorizeScope(requirement: AccessRequirement, credential: AccessCredential | null): void {
	if (credential === null || credential.native) {
		return;
	}
	const denied = requirement.kind === undefined ? requiresCredential(requirement) : !allowsPermission(credential, requirement.kind);
	if (denied) {
		throw new AccessDenied('PERMISSION_DENIED');
	}
}

/** endpointの要件と呼び出し元を束縛する。判定が一度も行われなかったかを`authorized`で確認できる。 */
export function createAccessRequest(requirement: AccessRequirement, credential: AccessCredential | null): AccessRequest & { readonly authorized: boolean } {
	let authorized = false;
	if (!requiresCredential(requirement)) {
		authorizeScope(requirement, credential);
		authorized = true;
	}
	return {
		credential,
		get authorized() {
			return authorized;
		},
		authorize(facts) {
			const result = authorizeAccess(requirement, requireCredential(credential), facts);
			authorized = true;
			return result;
		},
	};
}
