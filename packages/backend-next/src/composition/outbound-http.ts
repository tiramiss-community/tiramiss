/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createOutboundAgents } from '../platform/outbound-http/agents.js';
import { createOutboundHttp } from '../platform/outbound-http/client.js';
import type { OutboundHttp } from '../application/outbound-http.js';
import type { RuntimeConfig } from '../config/types.js';

/**
 * UseCase へ渡す外向き HTTP の関数を組み立てる。
 * private 宛ての遮断は本家と同じく本番だけで行う。テストは checkPrivateAddress で有効にする。
 */
export function createOutboundHttpClient(
	config: Pick<RuntimeConfig, 'userAgent' | 'outboundHttp'>,
	options: {
		checkPrivateAddress: boolean;
	} = { checkPrivateAddress: process.env.NODE_ENV === 'production' },
): OutboundHttp & {
	close(): Promise<void>;
} {
	const agents = createOutboundAgents({ ...config.outboundHttp, checkPrivateAddress: options.checkPrivateAddress });
	return {
		...createOutboundHttp(agents, config.userAgent), async close() {
			for (const agent of new Set([agents.httpNative, agents.httpsNative, agents.http, agents.https, agents.httpAgent, agents.httpsAgent])) {
				agent.destroy();
			}
		}
	};
}
