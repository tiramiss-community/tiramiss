/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash, verify } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Socket } from 'node:net';
export interface PeerRequest {
	method: string;
	path: string;
	headers: IncomingMessage['headers'];
	body: string;
	keyId: string | null;
	signature: boolean | null;
	digest: boolean | null;
}
export interface PeerReply {
	status?: number;
	type?: string;
	body?: unknown;
	headers?: Record<string, string>;
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return (server.address() as {
		port: number;
	}).port;
}

export async function startRemotePeer() {
	const routes = new Map<string, number>();
	const requests: PeerRequest[] = [];
	const discoveries: {
		url: string;
		actor: Record<string, unknown>;
	}[] = [];
	const pems = new Map<string, string>();
	const tunnels = new Set<Socket>();
	let handler: (req: PeerRequest) => Promise<PeerReply> = async req => ({ status: 404, body: { path: req.path } });

	async function discover(keyId: string): Promise<string> {
		const cached = pems.get(keyId);
		if (cached) {
			return cached;
		}
		const url = new URL(keyId);
		url.hash = '';
		const port = routes.get(url.hostname);
		if (!port) {
			throw new Error(`unknown signer host ${url.hostname}`);
		}
		const body = await new Promise<string>((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port, path: url.pathname, headers: { Accept: 'application/activity+json', Host: url.host } }, res => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', chunk => {
					text += chunk;
				});
				res.on('end', () => res.statusCode === 200 ? resolve(text) : reject(new Error(`key discovery status ${res.statusCode}: ${text}`)));
			});
			req.on('error', reject);
			req.end();
		});
		const actor = JSON.parse(body);
		if (actor.id !== url.href || actor.publicKey.id !== keyId || actor.publicKey.owner !== actor.id || !actor.publicKey.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) {
			throw new Error('invalid published key');
		}
		discoveries.push({ url: url.href, actor });
		pems.set(keyId, actor.publicKey.publicKeyPem);
		return actor.publicKey.publicKeyPem;
	}

	const peer = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				chunks.push(Buffer.from(chunk));
			}
			const body = Buffer.concat(chunks).toString();
			const sig = req.headers.signature as string | undefined;
			const keyId = sig?.match(/keyId="([^"]+)"/)?.[1] ?? null;
			const record: PeerRequest = { method: req.method!, path: req.url!, headers: req.headers, body, keyId, signature: null, digest: null };
			if (sig && keyId) {
				const pem = await discover(keyId);
				const fields = sig.match(/headers="([^"]+)"/)![1].split(' ');
				const signing = fields.map(name => name === '(request-target)' ? `(request-target): ${req.method!.toLowerCase()} ${req.url}` : `${name}: ${req.headers[name]}`).join('\n');
				record.signature = verify('sha256', Buffer.from(signing), pem, Buffer.from(sig.match(/signature="([^"]+)"/)![1], 'base64'));
			}
			if (req.headers.digest) {
				record.digest = req.headers.digest === `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
			}
			requests.push(record);
			const reply = await handler(record);
			res.writeHead(reply.status ?? 200, { 'Content-Type': reply.type ?? 'application/activity+json', ...reply.headers });
			res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
		})().catch(error => {
			res.writeHead(500);
			res.end(String(error));
		});
	});
	const peerPort = await listen(peer);
	routes.set('remote.test', peerPort);
	const proxy = createServer();
	proxy.on('connect', (req, socket, head) => {
		const client = socket as Socket;
		const host = (req.url ?? '').split(':')[0];
		const port = routes.get(host);
		if (!port) {
			client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
			return;
		}
		tunnels.add(client);
		const target = connect(port, '127.0.0.1', () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			target.write(head);
			target.pipe(client);
			client.pipe(target);
		});
		tunnels.add(target);
		target.on('error', () => client.destroy());
		client.on('error', () => target.destroy());
		target.on('close', () => {
			tunnels.delete(target);
		});
		client.on('close', () => {
			tunnels.delete(client);
		});
	});
	const proxyPort = await listen(proxy);
	return {
		origin: 'http://remote.test', proxy: `http://127.0.0.1:${proxyPort}`, requests, discoveries,
		route(host: string, port: number = peerPort) {
			routes.set(host, port);
		},
		respond(fn: typeof handler) {
			handler = fn;
		},
		clearKeys() {
			pems.clear();
		},
		async close() {
			for (const socket of tunnels) {
				socket.destroy();
			}
			peer.closeAllConnections();
			proxy.closeAllConnections();
			await Promise.all([new Promise<void>(r => peer.close(() => r())), new Promise<void>(r => proxy.close(() => r()))]);
		},
	};
}
export function plainActor(origin: string, name: string, patch: Record<string, unknown> = {}) {
	return {
		'@context': 'https://www.w3.org/ns/activitystreams', type: 'Person', id: `${origin}/users/${name}`, preferredUsername: name,
		inbox: `${origin}/inbox/${name}`, endpoints: { sharedInbox: `${origin}/inbox/shared` }, url: `${origin}/@${name}`,
		_misskey_summary: 'Remote profile', ...patch
	};
}
export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(r => {
		resolve = r;
	});
	return { promise, resolve };
}
