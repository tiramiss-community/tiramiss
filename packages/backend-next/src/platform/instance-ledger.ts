/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Not } from 'typeorm';
import { MiInstance } from 'backend-upstream/entities';
import { toPuny } from '../modules/federation/public.js';
import { DiagnosticError } from './diagnostic-error.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import type { InstanceFacts, InstanceLedger, InstancePatch } from '../modules/federation/public.js';

const redisTtlSeconds = 60 * 30;
const memoryTtlMs = 1000 * 60 * 3;
const suspendedHostsTtlMs = 1000 * 60 * 60;

/** Redis に置く値。本家 FederatedInstanceService のキャッシュと同じく instance 表の行全体の JSON。 */
type CachedRow = Record<string, unknown> & {
	id: string;
	host: string;
	isNotResponding: boolean;
	notRespondingSince: string | Date | null;
	suspensionState: InstanceFacts['suspensionState'];
	softwareName: string | null;
	softwareVersion: string | null;
};

function toFacts(row: CachedRow): InstanceFacts {
	return {
		id: row.id,
		host: row.host,
		isNotResponding: row.isNotResponding,
		notRespondingSinceMs: row.notRespondingSince === null ? null : new Date(row.notRespondingSince).getTime(),
		suspensionState: row.suspensionState,
		softwareName: row.softwareName,
		softwareVersion: row.softwareVersion,
	};
}

function toColumns(patch: InstancePatch): Partial<MiInstance> {
	const { notRespondingSinceMs, ...rest } = patch;
	return {
		...rest,
		...(notRespondingSinceMs === undefined ? {} : { notRespondingSince: notRespondingSinceMs === null ? null : new Date(notRespondingSinceMs) }),
	};
}

/**
 * 本家 FederatedInstanceService と DeliverProcessorService の停止ホスト一覧。
 * キャッシュは本家と同じキー・期限・値の形にする。切り替え時に残った本家のキャッシュを読んでも結果を変えないため。
 */
export function createInstanceLedger(options: {
	manager: EntityManager;
	redis: Redis;
	newId(time: number): string;
	clock?: () => number;
}): InstanceLedger {
	const { manager, redis, newId, clock = Date.now } = options;
	const repository = manager.getRepository(MiInstance);
	const memory = new Map<string, { storedAt: number; value: InstanceFacts | null }>();
	let sweptAt = clock();
	let suspended: { cachedAt: number; hosts: string[] } | null = null;

	const recall = (host: string): InstanceFacts | null | undefined => {
		const entry = memory.get(host);
		if (entry === undefined) {
			return undefined;
		}
		if (clock() - entry.storedAt > memoryTtlMs) {
			memory.delete(host);
			return undefined;
		}
		return entry.value;
	};

	// 本家の定期 GC の代わりに、書き込みのついでに期限切れを掃除する。タイマーを持つと解放処理が必要になるため。
	const remember = (host: string, value: InstanceFacts | null) => {
		const now = clock();
		if (now - sweptAt > memoryTtlMs) {
			for (const [key, entry] of memory) {
				if (now - entry.storedAt > memoryTtlMs) {
					memory.delete(key);
				}
			}
			sweptAt = now;
		}
		memory.set(host, { storedAt: now, value });
	};

	const get = async (host: string): Promise<InstanceFacts | null | undefined> => {
		const remembered = recall(host);
		if (remembered !== undefined) {
			return remembered;
		}
		const cached = await redis.get(`kvcache:federatedInstance:${host}`);
		if (cached === null) {
			return undefined;
		}
		const parsed = JSON.parse(cached) as CachedRow | null;
		const value = parsed === null ? null : toFacts(parsed);
		remember(host, value);
		return value;
	};

	const set = async (host: string, row: CachedRow | MiInstance | null): Promise<InstanceFacts | null> => {
		const value = row === null ? null : toFacts(row as CachedRow);
		remember(host, value);
		await redis.set(`kvcache:federatedInstance:${host}`, JSON.stringify(row), 'EX', redisTtlSeconds);
		return value;
	};

	return {
		async fetchInstance(rawHost) {
			const host = toPuny(rawHost);
			const cached = await get(host);
			if (cached !== undefined) {
				return cached;
			}
			return await set(host, await repository.findOneBy({ host }));
		},

		async fetchOrRegisterInstance(rawHost) {
			const host = toPuny(rawHost);
			// 本家と同じく、null のキャッシュは素通りして DB を確かめる。
			const cached = await get(host);
			if (cached) {
				return cached;
			}

			let row = await repository.findOneBy({ host });
			if (row === null) {
				// 本家は同じ host の初回登録が重なると一意制約の違反で失敗する。配送ジョブは並行に動くため、競合した側も登録済みの行を使う。
				const now = clock();
				await repository.createQueryBuilder().insert().values({ id: newId(now), host, firstRetrievedAt: new Date(now) }).orIgnore().execute();
				row = await repository.findOneByOrFail({ host });
			}
			return (await set(host, row))!;
		},

		async updateInstance(id, patch) {
			const result = await repository.createQueryBuilder().update().set(toColumns(patch)).where('id = :id', { id }).returning('*').execute();
			const row = (result.raw as CachedRow[])[0];
			if (row === undefined) {
				throw new DiagnosticError('INSTANCE_NOT_FOUND', { id });
			}
			await set(row.host, row);
		},

		async listSuspendedHosts() {
			if (suspended !== null && clock() - suspended.cachedAt <= suspendedHostsTtlMs) {
				return suspended.hosts;
			}
			const rows = await repository.find({ where: { suspensionState: Not('none') }, select: { host: true } });
			suspended = { cachedAt: clock(), hosts: rows.map(row => row.host) };
			return suspended.hosts;
		},
	};
}
