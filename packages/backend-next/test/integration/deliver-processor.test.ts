/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiInstance, MiMeta } from 'backend-upstream/entities';
import { OutboundStatusError } from '../../src/application/outbound-http.js';
import { createDeliverJobProcessor, createHostRules } from '../../src/modules/federation/public.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { readDeliverJobSettings } from '../../src/platform/database/meta.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createInstanceLedger } from '../../src/platform/instance-ledger.js';
import { settleDeliverJob } from '../../src/platform/job-queue/deliver.js';
import { createTestDatabase } from '../helpers/database.js';
import { loadApDeliverCases } from '../helpers/ap-deliver-cases.js';
import type { DataSource } from 'typeorm';
import type { InstanceLedger } from '../../src/modules/federation/public.js';

type Failure =
	| { kind: 'none' }
	| { kind: 'status'; statusCode: number; statusMessage: string }
	| { kind: 'error'; name: string; message: string; props: Record<string, unknown> };

type InstanceRow = Record<string, unknown> & { id: string; host: string };

interface ProcessorCases {
	inputs: {
		now: string;
		selfHost: string;
		job: { user: { id: string }; content: string; digest: string };
		meta: Record<string, unknown>;
		cases: {
			id: string;
			meta: Record<string, unknown>;
			instances: InstanceRow[];
			suspendedHostsCache?: string[];
			steps: { to: string; isSharedInbox: boolean; failure: Failure; advanceMs?: number }[];
		}[];
	};
	cases: {
		id: string;
		steps: {
			returned?: string;
			thrown?: { name: string; message: string; unrecoverable: boolean; original: boolean };
			signedPosts: unknown[][];
			instanceServiceCalls: unknown[][];
			redisSets: [string, string, string, 'EX', number][];
		}[];
		instances: InstanceRow[];
	}[];
}

const recorded = loadApDeliverCases<ProcessorCases>('processor-cases.json');
const { inputs } = recorded;
const expected = new Map(recorded.cases.map(c => [c.id, c]));
const redisTtlSeconds = 1800;

// 本家は shared inbox の 410 で不通の記録と goneSuspended を並行に書き、未登録の host では初回登録の競合で goneSuspended を失う。
// 新実装は順に書くため、登録済みの host と同じく goneSuspended も残る（意図的な差異）。
const sequentialGone = new Set(['fail-410-shared-unknown-stats-off']);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

function failureOf(failure: Failure): Error | null {
	switch (failure.kind) {
		case 'none':
			return null;
		case 'status':
			return new OutboundStatusError(`${failure.statusCode} ${failure.statusMessage}`, failure.statusCode, failure.statusMessage);
		case 'error':
			return Object.assign(new Error(failure.message), { name: failure.name }, failure.props);
	}
}

// 本家の記録と比べる列。他の列は配送では書かない。
const compared = ['host', 'isNotResponding', 'notRespondingSince', 'suspensionState', 'softwareName', 'softwareVersion'] as const;

function project(row: object) {
	const values = row as Record<string, unknown>;
	return Object.fromEntries(compared.map(key => [key, values[key] instanceof Date ? (values[key] as Date).toISOString() : values[key]]));
}

/** 試験の前に登録した行以外の ID は実行ごとに変わるため、host で名前を付け直す。 */
function nameIds(value: unknown, ids: Map<string, string>): unknown {
	return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === 'string' && ids.has(item) ? ids.get(item) : item));
}

test.for(inputs.cases)('$id processes deliveries like the pinned upstream DeliverProcessorService', async c => {
	const upstream = expected.get(c.id)!;
	await source.getRepository(MiInstance).clear();
	await source.getRepository(MiMeta).clear();
	await source.getRepository(MiMeta).insert({ id: 'x', ...inputs.meta, ...c.meta });

	const prefix = `ledger-test-${randomUUID()}:`;
	const redis = new Redis({ ...database.config.redis, keyPrefix: prefix });
	let now = Date.parse(inputs.now);
	const clock = () => now;
	const ledger = createInstanceLedger({ manager: source.manager, redis, newId: createIdCodec('aidx').newId, clock });

	if (c.suspendedHostsCache) {
		// 本家の probe と同じく、行を入れる前の一覧で停止ホストのキャッシュを埋めておく。
		expect(await ledger.listSuspendedHosts()).toEqual(c.suspendedHostsCache);
	}
	for (const row of c.instances) {
		await source.getRepository(MiInstance).insert({
			...row, firstRetrievedAt: new Date(now), notRespondingSince: row.notRespondingSince === null ? null : new Date(row.notRespondingSince as string),
		} as Partial<MiInstance>);
	}

	const calls: unknown[][] = [];
	const recording: InstanceLedger = {
		fetchInstance: host => {
			calls.push(['fetch', host]);
			return ledger.fetchInstance(host);
		},
		fetchOrRegisterInstance: host => {
			calls.push(['fetchOrRegister', host]);
			return ledger.fetchOrRegisterInstance(host);
		},
		updateInstance: (id, patch) => {
			const { notRespondingSinceMs, ...rest } = patch;
			calls.push(['update', id, { ...rest, ...(notRespondingSinceMs === undefined ? {} : { notRespondingSince: notRespondingSinceMs === null ? null : new Date(notRespondingSinceMs).toISOString() }) }]);
			return ledger.updateInstance(id, patch);
		},
		listSuspendedHosts: () => ledger.listSuspendedHosts(),
	};
	const ledgerFailures: unknown[] = [];
	let failure: Error | null = null;
	const signedPosts: unknown[][] = [];
	const processor = createDeliverJobProcessor({
		readSettings: () => readDeliverJobSettings(source.manager),
		hostRules: createHostRules(inputs.selfHost),
		ledger: recording,
		signedPost: async (...args) => {
			signedPosts.push(args);
			if (failure) {
				throw failure;
			}
		},
		currentTime: clock,
		reportLedgerFailure: error => {
			ledgerFailures.push(error);
		},
	});

	try {
		const lastSets = new Map<string, string>();
		for (const [index, step] of c.steps.entries()) {
			const upstreamStep = upstream.steps[index];
			now += step.advanceMs ?? 0;
			if ((step.advanceMs ?? 0) >= redisTtlSeconds * 1000) {
				// 本家の probe の Redis は固定時刻で EX を扱う。実 Redis の期限は進めた時刻に従わないため、ここで期限切れにする。
				// ioredis は KEYS の pattern に keyPrefix を付けない。
				const keys = await redis.keys(`${prefix}kvcache:*`);
				for (const key of keys) {
					await redis.del(key.slice(prefix.length));
				}
				lastSets.clear();
			}
			failure = failureOf(step.failure);
			signedPosts.length = 0;
			calls.length = 0;

			const outcome = await processor.process({ ...inputs.job, to: step.to, isSharedInbox: step.isSharedInbox });
			await processor.idle();

			let returned: string | undefined;
			let thrown: unknown;
			try {
				returned = settleDeliverJob(outcome);
			} catch (error) {
				thrown = error;
			}
			if (upstreamStep.returned !== undefined) {
				expect(returned).toBe(upstreamStep.returned);
			} else {
				const error = thrown as Error;
				expect({ name: error.name, message: error.message, unrecoverable: error instanceof UnrecoverableError, original: error === failure }).toEqual(upstreamStep.thrown);
			}
			expect(signedPosts).toEqual(upstreamStep.signedPosts);

			const rows = await source.getRepository(MiInstance).find();
			const ids = new Map(rows.filter(row => !c.instances.some(i => i.id === row.id)).map(row => [row.id, `registered:${row.host}`]));
			const upstreamIds = new Map(upstream.instances.filter(row => !c.instances.some(i => i.id === row.id)).map(row => [row.id, `registered:${row.host}`]));
			const expectedCalls = nameIds(upstreamStep.instanceServiceCalls, upstreamIds) as unknown[][];
			if (sequentialGone.has(c.id)) {
				expectedCalls.push(['update', 'registered:remote.example', { suspensionState: 'goneSuspended' }]);
			}
			// 本家は待たない更新を並行に始めるため、呼び出しの順ではなく内容を比べる。
			const sort = (list: unknown[][]) => list.map(item => JSON.stringify(item)).sort();
			expect(sort(nameIds(calls, ids) as unknown[][])).toEqual(sort(expectedCalls));

			for (const [, key, value] of upstreamStep.redisSets) {
				lastSets.set(key, value);
			}
		}

		const rows = await source.getRepository(MiInstance).find({ order: { host: 'ASC' } });
		const upstreamRows = [...upstream.instances].sort((a, b) => a.host.localeCompare(b.host));
		if (sequentialGone.has(c.id)) {
			upstreamRows[0] = { ...upstreamRows[0], suspensionState: 'goneSuspended' };
		}
		expect(rows.map(project)).toEqual(upstreamRows.map(project));
		expect(ledgerFailures).toEqual([]);

		// 本家と同じキー・期限に、行全体（全列）か null の JSON を置く。
		for (const [key, value] of lastSets) {
			const upstreamValue = JSON.parse(value) as Record<string, unknown> | null;
			const cached = await redis.get(key);
			expect(cached, key).not.toBeNull();
			const ttl = await redis.ttl(key);
			expect(ttl).toBeGreaterThan(redisTtlSeconds - 10);
			expect(ttl).toBeLessThanOrEqual(redisTtlSeconds);
			const parsed = JSON.parse(cached!) as Record<string, unknown> | null;
			if (upstreamValue === null || parsed === null) {
				expect(parsed).toEqual(upstreamValue);
				continue;
			}
			expect(Object.keys(parsed).sort()).toEqual(Object.keys(upstreamValue).sort());
			const expectedRow = sequentialGone.has(c.id) ? { ...upstreamValue, suspensionState: 'goneSuspended' } : upstreamValue;
			expect(project(parsed)).toEqual(project(expectedRow));
		}
	} finally {
		redis.disconnect();
	}
});

test('a cached instance written by upstream is read back with its dates', async () => {
	const prefix = `ledger-test-${randomUUID()}:`;
	const redis = new Redis({ ...database.config.redis, keyPrefix: prefix });
	try {
		await redis.set('kvcache:federatedInstance:cached.example', JSON.stringify({
			id: 'cached', host: 'cached.example', firstRetrievedAt: '2026-01-01T00:00:00.000Z', isNotResponding: true,
			notRespondingSince: '2026-10-01T00:00:00.000Z', suspensionState: 'none', softwareName: 'misskey', softwareVersion: '2025.1.0',
			latestRequestReceivedAt: null, infoUpdatedAt: null,
		}), 'EX', redisTtlSeconds);
		await redis.set('kvcache:federatedInstance:unknown.example', 'null', 'EX', redisTtlSeconds);
		const ledger = createInstanceLedger({ manager: source.manager, redis, newId: createIdCodec('aidx').newId });

		expect(await ledger.fetchInstance('cached.example')).toEqual({
			id: 'cached', host: 'cached.example', isNotResponding: true, notRespondingSinceMs: Date.parse('2026-10-01T00:00:00.000Z'),
			suspensionState: 'none', softwareName: 'misskey', softwareVersion: '2025.1.0',
		});
		// null のキャッシュは fetch では返し、fetchOrRegister では DB を確かめて登録する。
		expect(await ledger.fetchInstance('unknown.example')).toBeNull();
		expect(await ledger.fetchOrRegisterInstance('unknown.example')).toMatchObject({ host: 'unknown.example', isNotResponding: false });
	} finally {
		redis.disconnect();
	}
});

test('concurrent first registrations of the same host end with one row and no failure', async () => {
	await source.getRepository(MiInstance).delete({ host: 'race.example' });
	const ledgers = Array.from({ length: 4 }, () => {
		const redis = new Redis({ ...database.config.redis, keyPrefix: `ledger-test-${randomUUID()}:` });
		return { redis, ledger: createInstanceLedger({ manager: source.manager, redis, newId: createIdCodec('aidx').newId }) };
	});
	try {
		const registered = await Promise.all(ledgers.map(({ ledger }) => ledger.fetchOrRegisterInstance('race.example')));

		expect(new Set(registered.map(instance => instance.id)).size).toBe(1);
		expect(await source.getRepository(MiInstance).countBy({ host: 'race.example' })).toBe(1);
	} finally {
		for (const { redis } of ledgers) {
			redis.disconnect();
		}
	}
});
