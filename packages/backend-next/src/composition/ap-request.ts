/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createSignedPostSender } from '../modules/federation/public.js';
import type { OutboundHttp } from '../application/outbound-http.js';
import type { RuntimeConfig } from '../config/types.js';
import type { FederationKeys } from './federation-keys.js';

/** 署名付きの AP 送信を組み立てる。鍵と外向き HTTP は 1 プロセスで 1 回だけ作ったものを受け取る。 */
export function createApRequest(
	parts: { keys: Pick<FederationKeys, 'readUserKeypair'>; http: Pick<OutboundHttp, 'send'> },
	config: Pick<RuntimeConfig, 'url'>,
) {
	return {
		signedPost: createSignedPostSender({
			readUserKeypair: parts.keys.readUserKeypair,
			send: parts.http.send,
			selfUrl: config.url,
			clock: Date.now,
		}),
	};
}

export type ApRequest = ReturnType<typeof createApRequest>;
