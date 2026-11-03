/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import CacheableLookup from 'cacheable-lookup';
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent';
import { createAddressGuard } from './private-address.js';
import type { Duplex } from 'node:stream';
import type { OutboundHttpConfig } from '../../config/types.js';

export interface OutboundAgentOptions extends OutboundHttpConfig {
	/** 本家は NODE_ENV が production のときだけ判定する。条件は composition が決めて渡す。 */
	checkPrivateAddress: boolean;
}

export interface OutboundAgents {
	httpNative: http.Agent;
	httpsNative: https.Agent;
	http: http.Agent;
	https: https.Agent;
	httpAgent: http.Agent;
	httpsAgent: https.Agent;
	agentByUrl(url: URL, bypassProxy?: boolean, allowLocalAddress?: boolean): http.Agent | https.Agent;
}

type IsBlocked = (address: string | undefined) => boolean;

function watchConnect(socket: Duplex | null | undefined, isBlocked: IsBlocked): Duplex {
	if (socket == null) {
		throw new Error('Failed to create socket');
	}

	// 名前解決の結果ではなく接続先で判定する。DNS rebinding で解決後に宛先が変わっても遮断できるため。
	socket.on('connect', () => {
		if (socket instanceof net.Socket && isBlocked(socket.remoteAddress)) {
			socket.destroy(new Error(`Blocked address: ${socket.remoteAddress}`));
		}
	});

	return socket;
}

class GuardedHttpAgent extends http.Agent {
	constructor(private readonly isBlocked: IsBlocked, options: http.AgentOptions) {
		super(options);
	}

	override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex {
		return watchConnect(super.createConnection(options, callback), this.isBlocked);
	}
}

class GuardedHttpsAgent extends https.Agent {
	constructor(private readonly isBlocked: IsBlocked, options: https.AgentOptions) {
		super(options);
	}

	override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex {
		return watchConnect(super.createConnection(options, callback), this.isBlocked);
	}
}

export function createOutboundAgents(options: OutboundAgentOptions): OutboundAgents {
	const isBlocked = createAddressGuard({ enabled: options.checkPrivateAddress, allowedPrivateNetworks: options.allowedPrivateNetworks ?? [] });

	const cache = new CacheableLookup({
		maxTtl: 3600,
		errorTtl: 30,
		// 本家と同じく dns.lookup へ戻らない。/etc/hosts の名前は DNS が答えない限り解決できない。
		lookup: false,
	});

	const agentOption = {
		keepAlive: true,
		keepAliveMsecs: 30 * 1000,
		lookup: cache.lookup as unknown as net.LookupFunction,
		localAddress: options.outgoingAddress,
	};

	const httpNative = new http.Agent(agentOption);
	const httpsNative = new https.Agent(agentOption);
	const guardedHttp = new GuardedHttpAgent(isBlocked, agentOption);
	const guardedHttps = new GuardedHttpsAgent(isBlocked, agentOption);

	const proxyOption = {
		keepAlive: true,
		keepAliveMsecs: 30 * 1000,
		maxSockets: Math.max(256, options.deliverJobConcurrency ?? 128),
		maxFreeSockets: 256,
		scheduling: 'lifo' as const,
		localAddress: options.outgoingAddress,
	};

	// 本家どおり proxy 経由の接続は判定しない。接続先は proxy になり、本来の宛先のアドレスを得られないため。
	const httpAgent = options.proxy ? new HttpProxyAgent({ ...proxyOption, proxy: options.proxy }) : guardedHttp;
	const httpsAgent = options.proxy ? new HttpsProxyAgent({ ...proxyOption, proxy: options.proxy }) : guardedHttps;
	const bypassHosts = options.proxyBypassHosts ?? [];

	return {
		httpNative,
		httpsNative,
		http: guardedHttp,
		https: guardedHttps,
		httpAgent,
		httpsAgent,
		agentByUrl(url, bypassProxy = false, allowLocalAddress = false) {
			const isHttp = url.protocol === 'http:';

			if (bypassProxy || bypassHosts.includes(url.hostname)) {
				if (allowLocalAddress) {
					return isHttp ? httpNative : httpsNative;
				}
				return isHttp ? guardedHttp : guardedHttps;
			}

			if (allowLocalAddress && !options.proxy) {
				return isHttp ? httpNative : httpsNative;
			}
			return isHttp ? httpAgent : httpsAgent;
		},
	};
}
