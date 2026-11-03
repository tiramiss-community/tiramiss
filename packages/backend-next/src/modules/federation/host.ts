/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { domainToASCII } from 'node:url';

export function toPuny(host: string): string {
	return domainToASCII(host.toLowerCase());
}

export function toPunyNullable(host: string | null | undefined): string | null {
	if (host == null) {
		return null;
	}
	return toPuny(host);
}

// url.host はポートを含み、既定でないポート付きでは toPuny が '' を返す。本家の DB 用ホストと揃えるため、ポートを外して補正しない。
export function extractDbHost(uri: string): string {
	return toPuny(new URL(uri).host);
}

export function punyHost(url: string): string {
	const parsed = new URL(url);
	return `${toPuny(parsed.hostname)}${parsed.port.length > 0 ? ':' + parsed.port : ''}`;
}

export interface HostRules {
	isSelfHost(host: string | null): boolean;
	isUriLocal(uri: string): boolean;
	fullApAccount(username: string, host: string | null): string;
	// srcは `name@host` のhost部分（省略時はundefined）、noteUserHostは本文の所有者のhost。
	emojiHost(src: string | undefined, noteUserHost: string | null): string | null;
}

// selfHostは設定URLのhost（ポートを含む）。ポート付きでは本家と同じく '' に正規化され、自URIでもisUriLocalはfalseになる。
// 本家の判定結果と揃えるため、ポートを外して補正しない。
export function createHostRules(selfHost: string): HostRules {
	const self = toPuny(selfHost);
	const isSelfHost = (host: string | null) => host == null || toPuny(host) === self;

	return {
		isSelfHost,
		isUriLocal: uri => punyHost(uri) === self,
		fullApAccount: (username, host) => `${username}@${host ? toPuny(host) : self}`,
		emojiHost(src, noteUserHost) {
			const host = src === '.'
				? null
				: src === undefined
					? noteUserHost
					: isSelfHost(src)
						? null
						: src || noteUserHost;
			return toPunyNullable(host);
		},
	};
}
