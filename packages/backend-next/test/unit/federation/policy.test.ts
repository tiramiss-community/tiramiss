/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
	createHostRules, isBlockedHost, isDeliverSuspendedSoftware, isFederationAllowedHost, isFederationAllowedUri, isMediaSilencedHost, isSilencedHost,
} from '../../../src/modules/federation/public.js';
import type { FederationPolicy, SoftwareSuspension } from '../../../src/modules/federation/public.js';

type Software = { softwareName: string | null; softwareVersion: string | null };
type PolicyFile = {
	inputs: { selfHost: string; policies: Record<string, FederationPolicy>; deliverSuspendedSoftware: SoftwareSuspension[] };
	cases: (
		| { policy: string; host: string | null; expected: Record<string, boolean | null> }
		| { fn: 'isFederationAllowedUri'; policy: string; uri: string; expected: boolean }
		| { software: Software; expected: SoftwareSuspension | null }
	)[];
};

const { inputs, cases } = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/federation-base/policy-cases.json', import.meta.url), 'utf8')) as PolicyFile;
const rules = createHostRules(inputs.selfHost);
const hostCases = cases.flatMap(c => 'host' in c ? [c] : []);
const uriCases = cases.flatMap(c => 'uri' in c ? [c] : []);
const softwareCases = cases.flatMap(c => 'software' in c ? [c] : []);

test.each(hostCases.map(c => [`${c.policy} ${c.host}`, c] as const))('host predicates match pinned upstream: %s', (_, c) => {
	const policy = inputs.policies[c.policy];
	expect({
		isFederationAllowedHost: c.host === null ? null : isFederationAllowedHost(policy, rules, c.host),
		isBlockedHost: isBlockedHost(policy, c.host),
		isSilencedHost: isSilencedHost(policy, c.host),
		isMediaSilencedHost: isMediaSilencedHost(policy, c.host),
	}).toEqual(c.expected);
});

test.each(uriCases.map(c => [`${c.policy} ${c.uri}`, c] as const))('isFederationAllowedUri matches pinned upstream: %s', (_, c) => {
	expect(isFederationAllowedUri(inputs.policies[c.policy], rules, c.uri)).toBe(c.expected);
});

test('every recorded policy case is checked', () => {
	expect(hostCases.length + uriCases.length + softwareCases.length).toBe(cases.length);
	expect(uriCases.length).toBeGreaterThan(0);
});

test.each(softwareCases.map(c => [JSON.stringify(c.software), c] as const))('delivery suspension matches pinned upstream: %s', (_, c) => {
	const policy = { ...inputs.policies.all, deliverSuspendedSoftware: inputs.deliverSuspendedSoftware };
	expect(isDeliverSuspendedSoftware(policy, c.software) ?? null).toEqual(c.expected);
});

test('the self host is allowed even when federation is none and the host is blocked', () => {
	const policy: FederationPolicy = { ...inputs.policies.none, blockedHosts: [inputs.selfHost] };
	expect(isFederationAllowedHost(policy, rules, inputs.selfHost)).toBe(true);
	expect(isBlockedHost(policy, inputs.selfHost)).toBe(true);
});
