/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import ipaddr from 'ipaddr.js';
import { describe, expect, test } from 'vitest';
import { OutboundStatusError } from '../../../src/application/outbound-http.js';
import { createOutboundAgents } from '../../../src/platform/outbound-http/agents.js';
import { createAddressGuard, isPrivateAddress, parseAllowedPrivateNetworks } from '../../../src/platform/outbound-http/private-address.js';

type UnitCase =
	| { fn: 'agentByUrl'; proxy: boolean; bypassListed: boolean; bypassProxy: boolean; allowLocalAddress: boolean; protocol: string; expected: string }
	| { fn: 'isPrivate'; address: string; allowed: string[]; range: Outcome; expected: Outcome }
	| { fn: 'invalidNetworks'; allowed: string[]; expected: Outcome }
	| { fn: 'statusError'; status: number; statusText: string; expected: Record<string, unknown> }
	| { fn: 'config'; name: string; expected: Record<string, unknown> };
type Outcome = { value: unknown } | { error: string };

const { cases } = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/outbound-http/unit-cases.json', import.meta.url), 'utf8')) as { cases: UnitCase[] };
const only = <F extends UnitCase['fn']>(fn: F) => cases.filter((c): c is Extract<UnitCase, { fn: F }> => c.fn === fn);

function outcome(work: () => unknown): Outcome {
	try {
		return { value: work() };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

describe('agent selection matches the pinned upstream truth table', () => {
	test.each(only('agentByUrl'))('proxy=$proxy listed=$bypassListed bypassProxy=$bypassProxy allowLocal=$allowLocalAddress $protocol', c => {
		const agents = createOutboundAgents({ proxy: c.proxy ? 'http://127.0.0.1:9' : undefined, proxyBypassHosts: ['listed.example'], checkPrivateAddress: true });
		const selected = agents.agentByUrl(new URL(`${c.protocol}//${c.bypassListed ? 'listed.example' : 'other.example'}/`), c.bypassProxy, c.allowLocalAddress);
		const names = ['httpNative', 'httpsNative', 'http', 'https', 'httpAgent', 'httpsAgent'] as const;

		expect(names.find(name => agents[name] === selected)).toBe(c.expected);
	});
});

describe('private address classification matches the pinned upstream', () => {
	test.each(only('isPrivate'))('$address with $allowed', c => {
		expect(outcome(() => ipaddr.parse(c.address).range())).toEqual(c.range);
		expect(outcome(() => isPrivateAddress(c.address, parseAllowedPrivateNetworks(c.allowed)))).toEqual(c.expected);
	});

	test.each(only('invalidNetworks'))('rejects $allowed with the same parse error the upstream raises per connection', c => {
		expect(outcome(() => parseAllowedPrivateNetworks(c.allowed))).toEqual(c.expected);
	});

	test('checks addresses only when enabled and ignores values that are not IP addresses', () => {
		const disabled = createAddressGuard({ enabled: false, allowedPrivateNetworks: [] });
		const enabled = createAddressGuard({ enabled: true, allowedPrivateNetworks: ['10.0.0.0/8'] });

		expect(disabled('127.0.0.1')).toBe(false);
		expect(enabled('127.0.0.1')).toBe(true);
		expect(enabled('10.1.2.3')).toBe(false);
		expect(enabled(undefined)).toBe(false);
		expect(enabled('not-an-address')).toBe(false);
	});
});

describe('OutboundStatusError classification matches the pinned upstream StatusError', () => {
	test.each(only('statusError'))('$status', c => {
		const error = new OutboundStatusError(`${c.status} ${c.statusText}`, c.status, c.statusText);

		expect(error).toBeInstanceOf(Error);
		expect({
			name: error.name, message: error.message, statusCode: error.statusCode, statusMessage: error.statusMessage,
			isClientError: error.isClientError, isRetryable: error.isRetryable,
		}).toEqual(c.expected);
	});
});
