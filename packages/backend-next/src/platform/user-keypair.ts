/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUserKeypair } from 'backend-upstream/entities';
import { DiagnosticError } from './diagnostic-error.js';
import { upgradePkcs1PrivateKeyPem, type RsaKeyPair } from './key-pair.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import type { Logger } from './logger.js';

// 値の形は本家のキャッシュ（MiUserKeypairのJSON）と同じにする。切り替え時に残った本家のキャッシュを読んでも結果を変えないため。
interface CachedKeypair {
	userId: string;
	publicKey: string;
	privateKey: string;
}

const redisTtlSeconds = 60 * 60 * 24;
const memoryTtlMs = 1000 * 60 * 60;
const sweepIntervalMs = 1000 * 60 * 3;

export function createUserKeypairReader(options: {
	manager: EntityManager;
	redis: Redis;
	logger: Logger;
	clock?: () => number;
}): (userId: string) => Promise<RsaKeyPair> {
	const { manager, redis, logger, clock = Date.now } = options;
	const memory = new Map<string, { storedAt: number; value: CachedKeypair }>();
	let sweptAt = clock();

	const recall = (userId: string): CachedKeypair | undefined => {
		const entry = memory.get(userId);
		if (entry === undefined) {
			return undefined;
		}
		if (clock() - entry.storedAt > memoryTtlMs) {
			memory.delete(userId);
			return undefined;
		}
		return entry.value;
	};

	// 本家の定期GCの代わりに、書き込みのついでに期限切れを掃除する。タイマーを持つと解放処理が必要になるため。
	const remember = (userId: string, value: CachedKeypair) => {
		const now = clock();
		if (now - sweptAt > sweepIntervalMs) {
			for (const [key, entry] of memory) {
				if (now - entry.storedAt > memoryTtlMs) {
					memory.delete(key);
				}
			}
			sweptAt = now;
		}
		memory.set(userId, { storedAt: now, value });
	};

	const load = async (userId: string): Promise<CachedKeypair> => {
		const repository = manager.getRepository(MiUserKeypair);
		const row = await repository.findOneBy({ userId });
		if (row == null) {
			throw new DiagnosticError('USER_KEYPAIR_NOT_FOUND', { userId });
		}

		const value = { userId: row.userId, publicKey: row.publicKey, privateKey: row.privateKey };
		const upgraded = upgradePkcs1PrivateKeyPem(row.privateKey);
		if (upgraded !== null) {
			value.privateKey = upgraded;
			// 本家と同じく保存を待たない。返す鍵は変換済みなので、保存に失敗しても次の読み込みで再び変換される。
			void repository.update({ userId }, { privateKey: upgraded }).catch((error: unknown) => {
				logger.error('user-keypair.upgrade-failed', { userId, error });
			});
		}
		return value;
	};

	return async (userId) => {
		const key = `kvcache:userKeypair:v2:${userId}`;
		let value = recall(userId);
		if (value === undefined) {
			const cached = await redis.get(key);
			if (cached !== null) {
				value = JSON.parse(cached) as CachedKeypair;
				remember(userId, value);
			}
		}
		if (value === undefined) {
			value = await load(userId);
			remember(userId, value);
			await redis.set(key, JSON.stringify(value), 'EX', redisTtlSeconds);
		}
		return { publicKeyPem: value.publicKey, privateKeyPem: value.privateKey };
	};
}
