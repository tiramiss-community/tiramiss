/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface Acct { username: string; host: string | null; }
export function parseAcct(value: string): Acct {
	if (value.startsWith('@')) {
		value = value.substring(1);
	}
	const split = value.split('@', 2);
	return { username: split[0], host: split[1] ?? null };
}
export function formatAcct(acct: Acct): string {
	return acct.host == null ? acct.username : `${acct.username}@${acct.host}`;
}

export function actorLookupAcct(value: string, isSelfHost: (host: string) => boolean): Acct {
	const acct = parseAcct(value);
	return { username: acct.username.toLowerCase(), host: acct.host === null || isSelfHost(acct.host) ? null : acct.host };
}
