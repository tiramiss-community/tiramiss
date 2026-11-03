/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import semver from 'semver';
import type { HostRules } from './host.js';

export type SoftwareSuspension = {
	software: string;
	versionRange: string;
};

export type FederationPolicy = {
	federation: 'all' | 'specified' | 'none';
	federationHosts: readonly string[];
	blockedHosts: readonly string[];
	silencedHosts: readonly string[];
	mediaSilencedHosts: readonly string[];
	deliverSuspendedSoftware: readonly SoftwareSuspension[];
};

// 一覧側は小文字化しない。保存時の正規化（#194）を経ない大文字の値は、本家と同じく一致しない。
function matchesHostSuffix(list: readonly string[], host: string): boolean {
	return list.some(x => `.${host.toLowerCase()}`.endsWith(`.${x}`));
}

export function isBlockedHost(policy: FederationPolicy, host: string | null): boolean {
	return host != null && matchesHostSuffix(policy.blockedHosts, host);
}

export function isSilencedHost(policy: FederationPolicy, host: string | null): boolean {
	return host != null && matchesHostSuffix(policy.silencedHosts, host);
}

export function isMediaSilencedHost(policy: FederationPolicy, host: string | null): boolean {
	return host != null && policy.mediaSilencedHosts.some(x => host.toLowerCase() === x);
}

export function isFederationAllowedHost(policy: FederationPolicy, rules: HostRules, host: string): boolean {
	if (rules.isSelfHost(host)) {
		return true;
	}
	if (policy.federation === 'none') {
		return false;
	}
	if (policy.federation === 'specified' && !matchesHostSuffix(policy.federationHosts, host)) {
		return false;
	}
	return !isBlockedHost(policy, host);
}

export function isDeliverSuspendedSoftware(
	policy: FederationPolicy,
	software: { softwareName: string | null; softwareVersion: string | null },
): SoftwareSuspension | undefined {
	const { softwareName, softwareVersion } = software;
	if (softwareName == null) {
		return undefined;
	}
	if (softwareVersion == null) {
		return policy.deliverSuspendedSoftware.find(x => x.software === softwareName && x.versionRange.trim() === '*');
	}
	return policy.deliverSuspendedSoftware.find(x => x.software === softwareName
		&& semver.satisfies(softwareVersion, x.versionRange, { includePrerelease: true }));
}
