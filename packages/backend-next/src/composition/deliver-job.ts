/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createDeliverJobProcessor, createHostRules } from '../modules/federation/public.js';
import { readDeliverJobSettings } from '../platform/database/meta.js';
import { createIdCodec } from '../platform/id-codec.js';
import { createInstanceMetadata } from '../platform/instance-metadata.js';
import { createInstanceLedger } from '../platform/instance-ledger.js';
import { createApRequest } from './ap-request.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

/**
 * 配送ジョブ 1 件を処理する関数を組み立てる。鍵・外向き HTTP・instance のキャッシュを持つため、1 プロセスで 1 回だけ作る。
 * idle() は、ジョブの結果を待たせずに始めた instance の更新の完了を待つ。
 */
export function createDeliverJobHandler(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const codec = createIdCodec(config.id);
	const { signedPost } = createApRequest({ keys: resources.federationKeys, http: resources.outboundHttp }, config);

	const ledger = createInstanceLedger({ manager, redis: resources.redis, newId: codec.newId });
	const fetchMetadata = createInstanceMetadata({ ledger, redis: resources.redis, http: resources.outboundHttp, clock: Date.now, reportFailure: (error, context) => resources.logger.error('instance-metadata.failed', { ...context, error }) });
	return createDeliverJobProcessor({
		fetchMetadata,
		readSettings: () => readDeliverJobSettings(manager),
		hostRules: createHostRules(new URL(config.url).host),
		ledger,
		signedPost,
		currentTime: Date.now,
		reportLedgerFailure: (error, { to }) => {
			resources.logger.error('deliver.instance-update-failed', { to, error });
		},
	});
}
