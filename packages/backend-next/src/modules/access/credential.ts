/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 認証済みの呼び出し元。nativeトークン（ユーザー自身のトークン）は全permissionを持ち、
 * App・MiAuth・OAuthのトークンは保存されたpermissionの集合だけを持つ。
 */
export type AccessCredential =
	| { readonly userId: string; readonly native: true }
	| { readonly userId: string; readonly native: false; readonly permissions: ReadonlySet<string> };

export function allowsPermission(credential: AccessCredential, permission: string): boolean {
	return credential.native || credential.permissions.has(permission);
}
