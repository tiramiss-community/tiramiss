/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { UnrecoverableError } from 'bullmq';
import { init } from 'slacc';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { ApRequestCreator, ApRequestService } from '@/core/activitypub/ApRequestService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { StatusError } from '@/misc/status-error.js';
import { DeliverProcessorService } from '@/queue/processors/DeliverProcessorService.js';
import { installFakeDns, startFakeServers } from './outbound-http-fakes.js';
import type { ClientSettings, FakeServers, InboxCase } from './outbound-http-fakes.js';
import type { Config } from '@/config.js';

// 対象はre2を使わない。ネイティブモジュールを.node-versionのNodeで再ビルドせずに実行できるよう差し替える。
vi.mock('re2', () => ({ default: class {} }));

// 本家は起動時（boot/common.ts）と単体用の環境（environment.unit.ts）で slacc を初期化してから署名する。
init(1);

type SigningCase =
	| { id: string; method: 'POST'; url: string; body: string; digest?: string; additionalHeaders: Record<string, string> }
	| { id: string; method: 'GET'; url: string; additionalHeaders: Record<string, string> };

type Failure =
	| { id: string; kind: 'none' }
	| { id: string; kind: 'status'; statusCode: number; statusMessage?: string }
	| { id: string; kind: 'error'; name: string; message: string; props?: Record<string, unknown> };

const write = process.env.AP_REQUEST_PROBE_WRITE === '1';
const keypair = JSON.parse(readFileSync(new URL('./test-only-keypair.json', import.meta.url), 'utf8')) as { publicKeyPem: string; privateKeyPem: string };

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

function errorShape(error: unknown) {
	const e = error as Error & { code?: unknown };
	return { name: e.name, message: e.message, code: e.code };
}

function failureOf(failure: Failure): { error: unknown } | null {
	switch (failure.kind) {
		case 'none':
			return null;
		case 'status':
			// HttpRequestService.send と同じ組み立て。
			return { error: new StatusError(`${failure.statusCode} ${failure.statusMessage}`, failure.statusCode, failure.statusMessage) };
		case 'error':
			return { error: Object.assign(new Error(failure.message), { name: failure.name }, failure.props) };
	}
}

/**
 * 本家の DeliverProcessorService.process を、配送前の判定がすべて通る状態（連合は all、停止中のホストなし、統計なし）で動かす。
 * signedPost は与えた結果を返すだけにし、分類と goneSuspended の更新要求だけを記録する。
 */
async function classify(to: string, isSharedInbox: boolean, failure: { error: unknown } | null) {
	const updates: Record<string, unknown>[] = [];
	const federatedInstanceService = {
		fetch: async () => null,
		fetchOrRegister: async (host: string) => ({ id: 'instance', host, isNotResponding: false, notRespondingSince: null, suspensionState: 'none' }),
		update: async (_id: string, patch: Record<string, unknown>) => {
			updates.push(patch);
		},
	};
	const utilityService = new UtilityService({ host: 'probe.test' } as never, { federation: 'all', federationHosts: [], blockedHosts: [], deliverSuspendedSoftware: [] } as never);
	const signedPost = async () => {
		if (failure) {
			throw failure.error;
		}
	};
	const processor = new DeliverProcessorService(
		{ enableStatsForFederatedInstances: false, enableChartsForFederatedInstances: false } as never,
		{ find: async () => [] } as never,
		utilityService,
		federatedInstanceService as never,
		{ fetchInstanceMetadata: async () => {} } as never,
		{ signedPost } as never,
		{ requestSent: () => {} } as never,
		{ deliverSucc: () => {}, deliverFail: () => {} } as never,
		{ deliverd: () => {} } as never,
		{ logger: { createSubLogger: () => ({}) } } as never,
	);

	let result: Record<string, unknown>;
	try {
		result = { returned: await processor.process({ data: { user: { id: '9zz0probe' }, content: '{}', digest: 'SHA-256=probe', to, isSharedInbox } } as never) };
	} catch (error) {
		const e = error as Error;
		result = { thrown: { name: e.name, message: e.message, unrecoverable: e instanceof UnrecoverableError, original: failure !== null && e === failure.error } };
	}

	// 失敗時の instance 更新は待たれずに走る。投げた後の更新要求を拾うため、マイクロタスクを流しきる。
	await new Promise(resolve => setImmediate(resolve));
	return { ...result, goneSuspended: updates.some(patch => patch.suspensionState === 'goneSuspended') };
}

test('pinned upstream ApRequestCreator signing', async () => {
	const { path, inputs, cases } = load<{ now: string; keyId: string; cases: SigningCase[] }>('signing-cases.json');
	const key = { privateKeyPem: keypair.privateKeyPem, keyId: inputs.keyId };
	const actual: unknown[] = [];

	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(inputs.now));
	try {
		for (const c of inputs.cases) {
			let signed: Awaited<ReturnType<typeof ApRequestCreator.createSignedGet>>;
			try {
				signed = c.method === 'POST'
					? await ApRequestCreator.createSignedPost({ key, url: c.url, body: c.body, digest: c.digest, additionalHeaders: c.additionalHeaders })
					: await ApRequestCreator.createSignedGet({ key, url: c.url, additionalHeaders: c.additionalHeaders });
			} catch (error) {
				actual.push({ id: c.id, error: errorShape(error) });
				continue;
			}

			// 新実装は node:crypto で署名する。slacc の出力と byte 単位で一致することをここで確かめる。
			expect(sign('sha256', Buffer.from(signed.signingString), keypair.privateKeyPem).toString('base64')).toBe(signed.signature);
			actual.push({ id: c.id, expected: signed });
		}
	} finally {
		vi.useRealTimers();
	}

	settle(path, inputs, cases, JSON.parse(JSON.stringify(actual)));
});

test('pinned upstream DeliverProcessorService result classification', async () => {
	const { path, inputs, cases } = load<{ inboxes: { to: string; isSharedInbox: boolean }[]; failures: Failure[] }>('delivery-cases.json');
	const actual: unknown[] = [];

	for (const { to, isSharedInbox } of inputs.inboxes) {
		for (const failure of inputs.failures) {
			actual.push({ to, isSharedInbox, failure, expected: await classify(to, isSharedInbox, failureOf(failure)) });
		}
	}

	settle(path, inputs, cases, JSON.parse(JSON.stringify(actual)));
});

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

test('pinned upstream ApRequestService.signedPost against a fake inbox', async () => {
	const { path, inputs, cases } = load<{ selfUrl: string; userId: string; now: string; cases: InboxCase[] }>('inbox-cases.json');
	const actual: unknown[] = [];

	const post = async (settings: ClientSettings, url: string, object: unknown, digest: string | undefined) => {
		const config = { ...settings, url: inputs.selfUrl } as unknown as Config;
		const userKeypairService = { getUserKeypair: async (userId: string) => ({ userId, publicKey: keypair.publicKeyPem, privateKey: keypair.privateKeyPem }) };
		const service = new ApRequestService(config, userKeypairService as never, new HttpRequestService(config), { getLogger: () => ({}) } as never, {} as never);
		await service.signedPost({ id: inputs.userId }, url, object, digest);
	};

	// timeout を含むため Date だけを固定し、timer は実時間で動かす。
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(inputs.now));
	try {
		for (const c of inputs.cases) {
			const { observation, failure } = await servers.runInbox(c, post, keypair.publicKeyPem);
			const to = servers.expand(c.url);
			const delivery = {
				personalInbox: await classify(to, false, failure),
				sharedInbox: await classify(to, true, failure),
			};
			actual.push({ ...observation, delivery: JSON.parse(servers.normalize(JSON.stringify(delivery))) });
		}
	} finally {
		vi.useRealTimers();
	}

	settle(path, inputs, cases, JSON.parse(JSON.stringify(actual)));
}, 120000);
