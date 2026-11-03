/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { UtilityService } from '@/core/UtilityService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';

// 対象の関数はre2を使わない。ネイティブモジュールを.node-versionのNodeで再ビルドせずに実行できるよう差し替える。
vi.mock('re2', () => ({ default: class {} }));

type HostInputs = {
	selfHosts: string[];
	hosts: (string | null)[];
	urls: string[];
	emojis: { name: string; noteUserHost: string | null }[];
	dbHostUris: string[];
};
type PolicyInputs = {
	selfHost: string;
	policies: Record<string, Record<string, unknown>>;
	hosts: (string | null)[];
	uris: string[];
	deliverSuspendedSoftware: { software: string; versionRange: string }[];
	software: { softwareName: string | null; softwareVersion: string | null }[];
};

const write = process.env.FEDERATION_BASE_PROBE_WRITE === '1';

function load<T>(name: string): { path: URL; inputs: T; cases: unknown[] } {
	const path = new URL(`./${name}`, import.meta.url);
	return { path, ...JSON.parse(readFileSync(path, 'utf8')) };
}

function settle(path: URL, inputs: unknown, stored: unknown[], actual: unknown[]) {
	if (write) {
		writeFileSync(path, JSON.stringify({ inputs, cases: actual }, null, '\t') + '\n');
		return;
	}
	expect(actual).toEqual(stored);
}

function utility(selfHost: string, meta: Record<string, unknown> = {}) {
	return new UtilityService({ host: selfHost } as never, meta as never);
}

function emojiService(selfHost: string) {
	const service = Object.create(CustomEmojiService.prototype);
	service.utilityService = utility(selfHost);
	return service as CustomEmojiService;
}

test('pinned upstream host normalization and self-host rules', () => {
	const { path, inputs, cases } = load<HostInputs>('host-cases.json');
	const plain = utility('misskey.example');
	const actual: unknown[] = [];

	for (const host of inputs.hosts) {
		if (host !== null) {
			actual.push({ fn: 'toPuny', host, expected: plain.toPuny(host) });
		}
		actual.push({ fn: 'toPunyNullable', host, expected: plain.toPunyNullable(host) });
	}
	for (const url of inputs.urls) {
		actual.push({ fn: 'punyHost', url, expected: plain.punyHost(url) });
	}
	for (const selfHost of inputs.selfHosts) {
		const rules = utility(selfHost);
		const emojis = emojiService(selfHost);
		for (const host of inputs.hosts) {
			actual.push({ fn: 'isSelfHost', selfHost, host, expected: rules.isSelfHost(host) });
			actual.push({ fn: 'fullApAccount', selfHost, host, expected: rules.getFullApAccount('alice', host) });
		}
		for (const url of inputs.urls) {
			actual.push({ fn: 'isUriLocal', selfHost, url, expected: rules.isUriLocal(url) });
		}
		for (const { name, noteUserHost } of inputs.emojis) {
			actual.push({ fn: 'emojiHost', selfHost, name, noteUserHost, expected: emojis.parseEmojiStr(name, noteUserHost).host });
		}
	}
	for (const uri of inputs.dbHostUris) {
		actual.push({ fn: 'extractDbHost', uri, expected: plain.extractDbHost(uri) });
	}

	settle(path, inputs, cases, actual);
});

test('pinned upstream federation policy predicates', () => {
	const { path, inputs, cases } = load<PolicyInputs>('policy-cases.json');
	const actual: unknown[] = [];

	for (const [policy, meta] of Object.entries(inputs.policies)) {
		const service = utility(inputs.selfHost, meta);
		for (const host of inputs.hosts) {
			actual.push({
				policy,
				host,
				expected: {
					isFederationAllowedHost: host === null ? null : service.isFederationAllowedHost(host),
					isBlockedHost: service.isBlockedHost(meta.blockedHosts as string[], host),
					isSilencedHost: service.isSilencedHost(meta.silencedHosts as string[], host),
					isMediaSilencedHost: service.isMediaSilencedHost(meta.mediaSilencedHosts as string[], host),
				},
			});
		}
		for (const uri of inputs.uris) {
			actual.push({ fn: 'isFederationAllowedUri', policy, uri, expected: service.isFederationAllowedUri(uri) });
		}
	}

	const suspension = utility(inputs.selfHost, { deliverSuspendedSoftware: inputs.deliverSuspendedSoftware });
	for (const software of inputs.software) {
		actual.push({ software, expected: suspension.isDeliverSuspendedSoftware(software) ?? null });
	}

	settle(path, inputs, cases, actual);
});
