/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

export interface SearchRequest { method: string; url: string; body: unknown }
export async function searchGateway(handle?: (request: SearchRequest) => Promise<{ status?: number; body?: unknown } | void>) {
	const requests: SearchRequest[] = [];
	const server = createServer(async (request: IncomingMessage, response) => {
		try {
			const chunks = [];
			for await (const chunk of request) {
				chunks.push(chunk);
			}
			const text = Buffer.concat(chunks).toString();
			const record = { method: request.method!, url: request.url!, body: text ? JSON.parse(text) : null };
			requests.push(record);
			const result = await handle?.(record);
			response.writeHead(result?.status ?? 202, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(result?.body ?? { taskUid: requests.length, indexUid: 'test---notes', status: 'enqueued', type: 'documentAdditionOrUpdate', enqueuedAt: new Date().toISOString() }));
		} catch (error) {
			response.writeHead(500, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ message: String(error), code: 'internal', type: 'internal', link: '' }));
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	return {
		requests, port,
		config: { host: '127.0.0.1', port, apiKey: '', index: 'test' },
		async close() {
			server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		},
	};
}
export function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
}
