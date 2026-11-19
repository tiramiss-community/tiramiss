/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import proxyaddr from '@fastify/proxy-addr';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { RuntimeConfig } from '../config/types.js';

declare module 'hono' {
	interface ContextVariableMap {
		recordApiIp?: (userId: string) => void;
	}
}

export const defaultTrustedProxies = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1/32', '::1/128', 'fc00::/7'];

export function apiIpLogging(record: (userId: string, ip: string) => void, configured: RuntimeConfig['trustProxy']) {
	const setting = configured ?? defaultTrustedProxies;
	const trust = typeof setting === 'boolean' ? () => setting
		: typeof setting === 'number' ? (_address: string, hop: number) => hop < setting
		: proxyaddr.compile(setting);
	return createMiddleware(async (context, next) => {
		context.set('recordApiIp', userId => {
			const incoming: IncomingMessage | undefined = context.env?.incoming;
			// app.request has no network peer; do not manufacture an address for it.
			if (incoming?.socket.remoteAddress) {
				record(userId, proxyaddr(incoming, trust));
			}
		});
		await next();
	});
}

/** Called only after authentication succeeds, including requests later rejected by the API. */
export function recordAuthenticatedApiIp(context: Context, userId: string | null | undefined): void {
	if (userId != null) {
		try {
			context.get('recordApiIp')?.(userId);
		} catch { /* Request address resolution must not replace the API's business result. */ }
	}
}
