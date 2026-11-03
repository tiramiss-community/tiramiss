/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import ipaddr from 'ipaddr.js';
import { load } from 'js-yaml';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { StatusError } from '@/misc/status-error.js';
import { loadConfig } from '@/config.js';
import { installFakeDns, startFakeServers } from './outbound-http-fakes.js';
import type { ClientSettings, FakeServers, HttpCase, ProbeClient } from './outbound-http-fakes.js';
import type { Config } from '@/config.js';

// 対象はre2を使わない。ネイティブモジュールを.node-versionのNodeで再ビルドせずに実行できるよう差し替える。
vi.mock('re2', () => ({ default: class {} }));

// 本家の loadConfig は compile-config が書いた built/._config_.json を読む。固定本家の作業ツリーを書き換えずに設定を与えるため、そのパスだけを差し替える。
const compiled = vi.hoisted(() => ({ source: '{}' }));
vi.mock('node:fs', async importOriginal => {
	const real = await importOriginal<typeof import('node:fs')>();
	const isCompiled = (path: unknown) => String(path).endsWith('/built/._config_.json');
	return {
		...real,
		existsSync: (path: string) => isCompiled(path) || real.existsSync(path),
		readFileSync: (path: string, ...rest: unknown[]) => (isCompiled(path) ? compiled.source : (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)),
	};
});

type UnitInputs = {
	addresses: string[];
	allowedNetworks: string[][];
	invalidNetworks: string[][];
	statusCodes: { status: number; statusText: string }[];
	agentMatrix: { proxy: boolean[]; bypassListed: boolean[]; bypassProxy: boolean[]; allowLocalAddress: boolean[]; protocol: string[] };
	configs: { name: string; yaml: string; env?: Record<string, string> }[];
};

const write = process.env.OUTBOUND_HTTP_PROBE_WRITE === '1';

function loadCases<T>(name: string): { path: URL; inputs: T; cases: unknown[] } {
	const path = new URL(`./${name}`, import.meta.url);
	return { path, ...JSON.parse(readFileSync(path, 'utf8') as string) };
}

function settle(path: URL, inputs: unknown, stored: unknown[], actual: unknown[]) {
	if (write) {
		writeFileSync(path, JSON.stringify({ inputs, cases: actual }, null, '\t') + '\n');
		return;
	}
	expect(actual).toEqual(stored);
}

function service(config: Partial<Config>) {
	return new HttpRequestService(config as Config);
}

function errorOf(work: () => unknown) {
	try {
		return { value: work() };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

test('pinned upstream agent selection, address classification, StatusError and config keys', async () => {
	const { path, inputs, cases } = loadCases<UnitInputs>('unit-cases.json');
	const actual: unknown[] = [];

	const m = inputs.agentMatrix;
	for (const proxy of m.proxy) {
		const s = service({ proxy: proxy ? 'http://127.0.0.1:9' : undefined, proxyBypassHosts: ['listed.example'] });
		const named = s as unknown as Record<string, unknown>;
		const names = ['httpNative', 'httpsNative', 'http', 'https', 'httpAgent', 'httpsAgent'];
		for (const bypassListed of m.bypassListed) {
			for (const bypassProxy of m.bypassProxy) {
				for (const allowLocalAddress of m.allowLocalAddress) {
					for (const protocol of m.protocol) {
						const agent = s.getAgentByUrl(new URL(`${protocol}//${bypassListed ? 'listed.example' : 'other.example'}/`), bypassProxy, allowLocalAddress);
						actual.push({ fn: 'agentByUrl', proxy, bypassListed, bypassProxy, allowLocalAddress, protocol, expected: names.find(name => named[name] === agent) });
					}
				}
			}
		}
	}

	for (const allowed of inputs.allowedNetworks) {
		const agent = (service({ allowedPrivateNetworks: allowed }) as unknown as { http: { isPrivateIp(ip: string): boolean } }).http;
		for (const address of inputs.addresses) {
			actual.push({ fn: 'isPrivate', address, allowed, range: errorOf(() => ipaddr.parse(address).range()), expected: errorOf(() => agent.isPrivateIp(address)) });
		}
	}

	for (const allowed of inputs.invalidNetworks) {
		const agent = (service({ allowedPrivateNetworks: allowed }) as unknown as { http: { isPrivateIp(ip: string): boolean } }).http;
		actual.push({ fn: 'invalidNetworks', allowed, expected: errorOf(() => agent.isPrivateIp('8.8.8.8')) });
	}

	for (const { status, statusText } of inputs.statusCodes) {
		const error = new StatusError(`${status} ${statusText}`, status, statusText);
		actual.push({ fn: 'statusError', status, statusText, expected: { name: error.name, message: error.message, statusCode: error.statusCode, statusMessage: error.statusMessage, isClientError: error.isClientError, isRetryable: error.isRetryable } });
	}

	const base = { port: 3000, db: { host: 'localhost', port: 5432, db: 'probe', user: 'probe', pass: 'probe' }, redis: { host: 'localhost', port: 6379 } };
	for (const config of inputs.configs) {
		compiled.source = JSON.stringify({ ...base, ...(load(config.yaml) as object) });
		const previous = Object.fromEntries(Object.keys(config.env ?? {}).map(key => [key, process.env[key]]));
		Object.assign(process.env, config.env ?? {});
		try {
			const loaded = loadConfig();
			actual.push({
				fn: 'config', name: config.name,
				expected: {
					userAgent: loaded.userAgent,
					proxy: loaded.proxy, proxyBypassHosts: loaded.proxyBypassHosts, allowedPrivateNetworks: loaded.allowedPrivateNetworks,
					outgoingAddress: loaded.outgoingAddress, deliverJobConcurrency: loaded.deliverJobConcurrency,
				},
			});
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	}

	settle(path, inputs, cases, JSON.parse(JSON.stringify(actual)));
});

function upstreamClient(settings: ClientSettings): ProbeClient {
	const s = service(settings as Partial<Config>);
	return {
		async send(url, options, extra) {
			const response = await s.send(url, {
				method: options.method,
				headers: options.headers,
				body: options.body as never,
				timeout: options.timeoutMs,
				size: options.maxBytes,
				isLocalAddressAllowed: options.allowLocalAddress,
			}, { throwErrorWhenResponseNotOk: extra.okOnly ?? true, validators: [] });
			return { status: response.status, statusText: response.statusText, finalUrl: response.url, text: () => response.text(), json: () => response.json() };
		},
		getJson: (url, accept, headers) => s.getJson(url, accept, headers),
	};
}

let servers: FakeServers;
let restoreDns: () => void;
const previousNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
	restoreDns = installFakeDns();
	servers = await startFakeServers();
	// 本家は接続のたびに NODE_ENV を見て private 判定を行う。
	process.env.NODE_ENV = 'production';
});

afterAll(async () => {
	process.env.NODE_ENV = previousNodeEnv;
	await servers?.close();
	restoreDns?.();
});

test('pinned upstream HttpRequestService against fake servers', async () => {
	const { path, inputs, cases } = loadCases<{ cases: HttpCase[] }>('http-cases.json');
	if (!servers.tls) {
		throw new Error('openssl is required to record the https cases');
	}

	const actual: unknown[] = [];
	for (const c of inputs.cases) {
		actual.push(await servers.run(c, upstreamClient));
	}

	settle(path, inputs, cases, JSON.parse(JSON.stringify(actual)));
}, 120000);
