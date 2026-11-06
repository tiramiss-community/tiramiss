/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { toSpkiPublicKeyPem } from '../modules/federation/public.js';
import { createSystemAccountEnsurer } from '../platform/database/system-account.js';
import { createIdCodec } from '../platform/id-codec.js';
import { generateRsaKeyPair } from '../platform/key-pair.js';
import { createUserKeypairReader } from '../platform/user-keypair.js';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import type { Logger } from '../platform/logger.js';
import type { RuntimeConfig } from '../config/types.js';

// メモリキャッシュを各関数が持つため、1プロセスで1回だけ作り、UseCaseへ関数として渡す。
export function createFederationKeys(resources: { dataSource: DataSource; redis: Redis; logger: Logger }, config: RuntimeConfig) {
	const codec = createIdCodec(config.id);
	return {
		generateRsaKeyPair,
		toSpkiPublicKeyPem,
		readUserKeypair: createUserKeypairReader({
			manager: resources.dataSource.manager,
			redis: resources.redis,
			logger: resources.logger,
		}),
		ensureSystemAccount: createSystemAccountEnsurer({ dataSource: resources.dataSource, newId: codec.newId }),
	};
}

export type FederationKeys = ReturnType<typeof createFederationKeys>;
