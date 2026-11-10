/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { OutboundStatusError } from '../../../src/application/outbound-http.js';
import {
	createDeliverJobProcessor, createHostRules, deliverFailurePatch, deliverSuccessPatch,
} from '../../../src/modules/federation/public.js';
import type { DeliverJobSettings, FederationPolicy, InstanceFacts, InstancePatch } from '../../../src/modules/federation/public.js';

const now = Date.parse('2026-11-03T00:00:00.000Z');
const day = 1000 * 60 * 60 * 24;
const known: InstanceFacts = {
	id: 'instance', host: 'remote.example', infoUpdatedAtMs: null, isNotResponding: false, notRespondingSinceMs: null, suspensionState: 'none', softwareName: null, softwareVersion: null,
};

test.for<[string, Partial<InstanceFacts>, InstancePatch | null]>([
	['responding → marked not responding from now', {}, { isNotResponding: true, notRespondingSinceMs: now }],
	['not responding without a start time → only the start time', { isNotResponding: true }, { notRespondingSinceMs: now }],
	['not responding for 6 days → unchanged', { isNotResponding: true, notRespondingSinceMs: now - 6 * day }, null],
	['not responding for 7 days minus 1 ms → unchanged', { isNotResponding: true, notRespondingSinceMs: now - 7 * day + 1 }, null],
	['not responding for exactly 7 days → auto suspended', { isNotResponding: true, notRespondingSinceMs: now - 7 * day }, { suspensionState: 'autoSuspendedForNotResponding' }],
	['already suspended for another reason → unchanged', { isNotResponding: true, notRespondingSinceMs: now - 30 * day, suspensionState: 'manuallySuspended' }, null],
])('a failed delivery to an instance that is %s', ([, change, patch]) => {
	expect(deliverFailurePatch({ ...known, ...change }, now)).toEqual(patch);
});

test('a successful delivery clears only the not-responding state', () => {
	expect(deliverSuccessPatch(known)).toBeNull();
	expect(deliverSuccessPatch({ ...known, isNotResponding: true, notRespondingSinceMs: now - day, suspensionState: 'goneSuspended' }))
		.toEqual({ isNotResponding: false, notRespondingSinceMs: null });
});

const policy: FederationPolicy = { federation: 'all', federationHosts: [], blockedHosts: [], silencedHosts: [], mediaSilencedHosts: [], deliverSuspendedSoftware: [] };
const job = { user: { id: 'alice' }, content: '{"type":"Create"}', digest: 'SHA-256=x', to: 'https://remote.example/inbox', isSharedInbox: true };

function processor(options: {
	settings?: Partial<DeliverJobSettings>;
	instances?: InstanceFacts[];
	suspended?: string[];
	post?: () => Promise<void>;
	update?: (id: string, patch: InstancePatch) => Promise<void>;
	metadata?: () => Promise<void>;
} = {}) {
	const calls: unknown[][] = [];
	const ledgerFailures: unknown[] = [];
	const instances = new Map((options.instances ?? []).map(i => [i.host, i]));
	const deliver = createDeliverJobProcessor({
		readSettings: async () => ({ policy, enableStatsForFederatedInstances: true, ...options.settings }),
		hostRules: createHostRules('local.example'),
		ledger: {
			fetchInstance: async host => {
				calls.push(['fetch', host]);
				return instances.get(host) ?? null;
			},
			fetchOrRegisterInstance: async host => {
				calls.push(['fetchOrRegister', host]);
				const instance = instances.get(host) ?? { ...known, id: `registered:${host}`, host };
				instances.set(host, instance);
				return instance;
			},
			updateInstance: async (id, patch) => {
				calls.push(['update', id, patch]);
				await options.update?.(id, patch);
			},
			listSuspendedHosts: async () => options.suspended ?? [],
		},
		signedPost: async (...args) => {
			calls.push(['signedPost', ...args]);
			await options.post?.();
		},
		currentTime: () => now,
		fetchMetadata: async () => {
 await options.metadata?.();
},
		reportLedgerFailure: error => {
			ledgerFailures.push(error);
		},
	});
	return { deliver, calls, ledgerFailures };
}

test('a blocked or suspended destination is skipped before reading the instance or sending', async () => {
	const blocked = processor({ settings: { policy: { ...policy, blockedHosts: ['remote.example'] } } });
	const suspended = processor({ suspended: ['remote.example'] });

	expect(await blocked.deliver.process(job)).toEqual({ kind: 'done', result: 'skip (blocked)' });
	expect(await suspended.deliver.process(job)).toEqual({ kind: 'done', result: 'skip (suspended)' });
	expect([...blocked.calls, ...suspended.calls]).toEqual([]);
});

test('suspended software is skipped after the instance is read, without sending', async () => {
	const { deliver, calls } = processor({
		settings: { policy: { ...policy, deliverSuspendedSoftware: [{ software: 'misskey', versionRange: '*' }] } },
		instances: [{ ...known, softwareName: 'misskey' }],
	});

	expect(await deliver.process(job)).toEqual({ kind: 'done', result: 'skip (software suspended)' });
	expect(calls).toEqual([['fetchOrRegister', 'remote.example']]);
});

test('without federated instance stats an unknown host is only looked up before sending', async () => {
	const { deliver, calls } = processor({ settings: { enableStatsForFederatedInstances: false } });

	expect(await deliver.process(job)).toEqual({ kind: 'done', result: 'Success' });
	await deliver.idle();
	expect(calls).toEqual([['fetch', 'remote.example'], ['signedPost', job.user, job.to, job.content, job.digest]]);
});

test('a success clears the not-responding state after the job result is returned', async () => {
	let release!: () => void;
	const blocked = new Promise<void>(resolve => {
		release = resolve;
	});
	const { deliver, calls } = processor({ instances: [{ ...known, isNotResponding: true, notRespondingSinceMs: now - day }], update: () => blocked });

	expect(await deliver.process(job)).toEqual({ kind: 'done', result: 'Success' });
	let idle = false;
	const waiting = deliver.idle().then(() => {
		idle = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(idle).toBe(false);
	release();
	await waiting;
	expect(calls.at(-1)).toEqual(['update', 'instance', { isNotResponding: false, notRespondingSinceMs: null }]);
});

test('a 410 from a shared inbox records the failure and then goneSuspended, so neither write is lost', async () => {
	const { deliver, calls } = processor({ post: () => Promise.reject(new OutboundStatusError('410 Gone', 410, 'Gone')) });

	expect(await deliver.process(job)).toEqual({ kind: 'stop', message: 'remote.example is gone', hostGone: true });
	await deliver.idle();
	expect(calls.filter(call => call[0] === 'update')).toEqual([
		['update', 'registered:remote.example', { isNotResponding: true, notRespondingSinceMs: now }],
		['update', 'registered:remote.example', { suspensionState: 'goneSuspended' }],
	]);
});

test('a failing instance update is reported and does not change the delivery result', async () => {
	const failure = new Error('instance table unavailable');
	const { deliver, ledgerFailures } = processor({ post: () => Promise.reject(new OutboundStatusError('503 Service Unavailable', 503, 'Service Unavailable')), update: () => Promise.reject(failure) });

	const outcome = await deliver.process(job);
	await deliver.idle();

	expect(outcome).toMatchObject({ kind: 'retry', error: { message: '503 Service Unavailable' } });
	expect(ledgerFailures).toEqual([failure]);
});

test.each(['pending', 'rejected'])('successful delivery starts metadata independently of %s responding update and drains', async state => {
	let releaseUpdate!: () => void;
	let releaseMetadata!: () => void;
	const update = new Promise<void>(resolve => {
		releaseUpdate = resolve;
	});
	const metadata = new Promise<void>(resolve => {
		releaseMetadata = resolve;
	});
	let started = false;
	const { deliver } = processor({
		instances: [{ ...known, isNotResponding: true }],
		update: () => state === 'pending' ? update : Promise.reject(Error('responding update')),
		metadata: async () => {
			started = true; await metadata;
		},
	});
	expect(await deliver.process(job)).toEqual({ kind: 'done', result: 'Success' });
	await new Promise<void>(resolve => process.nextTick(resolve));
	let drained = false;
	const idle = deliver.idle().then(() => {
		drained = true;
	});
	try {
		expect(started).toBe(true); expect(drained).toBe(false);
	} finally {
		releaseUpdate(); releaseMetadata(); await idle;
	}
});

// New actual-source success scheduling observations; historical delivery corpus remains unchanged.
test.each((JSON.parse((await import('node:fs')).readFileSync(new URL('../../../../../docs/superpowers/compatibility/instance-metadata/observations.json', import.meta.url), 'utf8')).callerCases) as { input: { stats: boolean; finalStats: boolean; instance: boolean; update?: string }; expected: { result: string; events: string[] } }[])('source success callback uses live statistics and independent work: $input', async fixture => {
	const events: string[] = [];
	let stats = fixture.input.stats;
	let release!: () => void;
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	const instance = fixture.input.instance ? { ...known, isNotResponding: true } : null;
	const deliver = createDeliverJobProcessor({
		readSettings: async () => ({ policy, enableStatsForFederatedInstances: stats }),
		hostRules: createHostRules('local.example'),
		ledger: {
			fetchInstance: async () => instance,
			fetchOrRegisterInstance: async () => instance!,
			listSuspendedHosts: async () => [],
			updateInstance: async () => {
				events.push('responding.start'); if (fixture.input.update === 'rejected') {
					throw Error('update');
				} await held;
			},
		},
		signedPost: async () => {
			events.push('post'); stats = fixture.input.finalStats;
		},
		fetchMetadata: async () => {
			events.push('metadata.start'); await held;
		},
		currentTime: () => now,
		reportLedgerFailure: () => { },
	});
	try {
		const result = await deliver.process(job); events.push('result.returned');
		await new Promise<void>(resolve => process.nextTick(resolve));
		expect(result).toEqual({ kind: 'done', result: fixture.expected.result });
		expect(events).toEqual(fixture.expected.events);
	} finally {
		release(); await deliver.idle();
	}
});
