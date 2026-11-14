/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export function renderLocalKey(id: string, selfUrl: string, publicKeyPem: string, postfix?: string) {
	const owner = `${selfUrl}/users/${id}`;
	return { id: `${owner}${postfix ?? '/publickey'}`, type: 'Key', owner, publicKeyPem };
}
