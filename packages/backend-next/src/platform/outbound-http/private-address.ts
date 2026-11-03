/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import ipaddr from 'ipaddr.js';

export type AllowedNetwork = [ipaddr.IPv4 | ipaddr.IPv6, number];

/** 不正な CIDR があれば、その文字列を添えて例外を投げる。 */
export function parseAllowedPrivateNetworks(networks: readonly string[]): AllowedNetwork[] {
	return networks.map(network => ipaddr.parseCIDR(network));
}

/**
 * 本家の HttpRequestServiceAgent.isPrivateIp と同じ判定。
 * CIDR はアドレスファミリーが一致するときだけ照合するため、`::ffff:` で写した IPv4 は IPv4 の CIDR で許可されない。
 */
export function isPrivateAddress(address: string, allowed: readonly AllowedNetwork[]): boolean {
	const parsed = ipaddr.parse(address);

	for (const network of allowed) {
		if (network[0].kind() === parsed.kind() && parsed.match(network)) {
			return false;
		}
	}

	return parsed.range() !== 'unicast';
}

export function createAddressGuard(options: { enabled: boolean; allowedPrivateNetworks: readonly string[] }): (address: string | undefined) => boolean {
	const allowed = parseAllowedPrivateNetworks(options.allowedPrivateNetworks);

	return address => {
		if (!options.enabled || !address || !ipaddr.isValid(address)) {
			return false;
		}
		return isPrivateAddress(address, allowed);
	};
}
