/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 外向き HTTP の比較用の偽サーバーと case の実行器。
// 本家の probe（docs/superpowers/compatibility/outbound-http/・ap-request/）も同じファイルを写して使うため、node の組み込みだけに依存する。
import { execFileSync } from 'node:child_process';
import { createHash, verify } from 'node:crypto';
import * as dns from 'node:dns';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { gzipSync } from 'node:zlib';

/** 偽の DNS が答える名前。127.0.0.2 は「公開アドレスの代役」として allowedPrivateNetworks で許可する。 */
export const fakeNames: Record<string, string> = {
	'public.outbound.test': '127.0.0.2',
	'sub.public.outbound.test': '127.0.0.2',
	'other.outbound.test': '127.0.0.2',
	'private.outbound.test': '127.0.0.1',
};

export const publicStandIn = ['127.0.0.2/32'];
export const probeUserAgent = 'Misskey/probe (https://probe.test)';

export type ProbeBody =
	| { kind: 'text'; value: string }
	| { kind: 'bytes'; value: string }
	| { kind: 'urlencoded'; fields: Record<string, string> }
	| { kind: 'form'; fields: Record<string, string> };

export interface HttpCase {
	id: string;
	config?: { proxy?: boolean; proxyBypassHosts?: string[]; allowedPrivateNetworks?: string[]; outgoingAddress?: string };
	op: 'send' | 'getJson';
	url: string;
	options?: { method?: string; headers?: Record<string, string>; body?: ProbeBody; timeoutMs?: number; maxBytes?: number; allowLocalAddress?: boolean };
	extra?: { okOnly?: boolean };
	read?: 'text' | 'json';
	accept?: string;
	headers?: Record<string, string>;
}

export interface ClientSettings {
	userAgent: string;
	proxy?: string;
	proxyBypassHosts?: string[];
	allowedPrivateNetworks?: string[];
	outgoingAddress?: string;
}

export interface ProbeResponse {
	status: number;
	statusText: string;
	finalUrl: string;
	text(): Promise<string>;
	json(): Promise<unknown>;
}

export interface ProbeClient {
	send(
		url: string,
		options: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | FormData | URLSearchParams; timeoutMs?: number; maxBytes?: number; allowLocalAddress?: boolean },
		extra: { okOnly?: boolean },
	): Promise<ProbeResponse>;
	getJson(url: string, accept?: string, headers?: Record<string, string>): Promise<unknown>;
}

interface RecordedRequest {
	listener: string;
	method: string;
	path: string;
	headers: [string, string][];
	remoteAddress: string;
	body: string | { length: number };
}

const recordedHeaders = new Set(['user-agent', 'accept', 'authorization', 'cookie', 'content-type', 'content-length', 'x-probe']);

/** 署名付きの送信先（偽の inbox）へ渡す case。`object` は本家の signedPost と同じく、文字列ならそのまま、それ以外は JSON にして送る。 */
export interface InboxCase {
	id: string;
	url: string;
	object: unknown;
	digest?: string;
}

/** 本家の ApRequestService.signedPost に相当する送信。失敗は送信元の例外をそのまま投げる。 */
export type InboxPost = (settings: ClientSettings, url: string, object: unknown, digest: string | undefined) => Promise<void>;

/** 偽の inbox が受け取った要求。署名と Digest は受信した値のまま検証してから、ポートと署名値を名前へ置き換える。 */
export interface InboxRequest {
	listener: string;
	method: string;
	path: string;
	headers: Record<string, string | string[]>;
	body: string;
	verified: { signature: boolean | null; digest: boolean | null };
}

export interface InboxObservation {
	id: string;
	error?: Record<string, unknown>;
	received: InboxRequest[];
}

interface ReceivedRequest {
	listener: string;
	method: string;
	path: string;
	headers: Record<string, string | string[]>;
	body: Buffer;
}

const inboxHeaders = new Set(['accept', 'content-length', 'content-type', 'date', 'digest', 'host', 'signature', 'user-agent']);

function single(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/** 受信側と同じ材料（method・受信した path・ヘッダー・本文）だけで、draft-cavage の署名と SHA-256 の Digest を検証する。 */
function verifyReceived(request: ReceivedRequest, publicKeyPem: string): InboxRequest['verified'] {
	const signatureHeader = single(request.headers.signature);
	let signature: boolean | null = null;
	if (signatureHeader !== undefined) {
		const params = Object.fromEntries([...signatureHeader.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
		const lines = (params.headers ?? '').split(' ').map(name => (name === '(request-target)'
			? `(request-target): ${request.method.toLowerCase()} ${request.path}`
			: `${name}: ${single(request.headers[name])}`));
		signature = verify('sha256', Buffer.from(lines.join('\n')), publicKeyPem, Buffer.from(params.signature ?? '', 'base64'));
	}

	const digestHeader = single(request.headers.digest);
	const digest = digestHeader === undefined ? null : digestHeader === `SHA-256=${createHash('sha256').update(request.body).digest('base64')}`;
	return { signature, digest };
}

/**
 * cacheable-lookup は生成時に dns.promises.Resolver の resolve4/resolve6 を束縛する。
 * 生成前に差し替えると、実 DNS を使わずに名前を 127.0.0.x へ向けられる。表にない名前（localhost を含む）は見つからない扱いにする。
 */
export function installFakeDns(): () => void {
	const proto = dns.promises.Resolver.prototype as unknown as Record<'resolve4' | 'resolve6', (hostname: string, options?: { ttl?: boolean }) => Promise<unknown>>;
	const original = { resolve4: proto.resolve4, resolve6: proto.resolve6 };

	proto.resolve4 = async (hostname, options) => {
		const address = fakeNames[hostname];
		if (!address) {
			throw Object.assign(new Error(`queryA ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
		}
		return options?.ttl ? [{ address, ttl: 60 }] : [address];
	};
	proto.resolve6 = async hostname => {
		throw Object.assign(new Error(`queryAaaa ENODATA ${hostname}`), { code: 'ENODATA', hostname });
	};

	return () => {
		proto.resolve4 = original.resolve4;
		proto.resolve6 = original.resolve6;
	};
}

function jsonOfLength(length: number): string {
	return `"${'a'.repeat(length - 2)}"`;
}

/** 圧縮が効かない決まった byte 列。展開前の大きさが上限を超え、展開後は超えない応答を作る。 */
function incompressible(length: number): Buffer {
	const bytes = Buffer.alloc(length);
	let state = 0x12345678;
	for (let i = 0; i < length; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		bytes[i] = state >>> 24;
	}
	return bytes;
}

function createTlsMaterial(): { cert: string; key: string } | null {
	const dir = mkdtempSync(join(tmpdir(), 'outbound-http-tls-'));
	try {
		execFileSync('openssl', [
			'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
			'-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=outbound.test',
			'-addext', `subjectAltName=${Object.keys(fakeNames).map(name => `DNS:${name}`).join(',')},IP:127.0.0.1,IP:127.0.0.2`,
		], { stdio: 'ignore' });
		return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface FakeServers {
	tls: boolean;
	expand(value: string): string;
	/** 実行ごとに変わるポートを名前へ戻す。 */
	normalize(value: string): string;
	run(c: HttpCase, client: (settings: ClientSettings) => ProbeClient): Promise<unknown>;
	/** 送信の観測と、送信が投げた例外そのもの（成功なら null）を返す。例外は配送結果の分類へ渡すために返す。 */
	runInbox(c: InboxCase, post: InboxPost, publicKeyPem: string): Promise<{ observation: InboxObservation; failure: { error: unknown } | null }>;
	close(): Promise<void>;
}

export async function startFakeServers(): Promise<FakeServers> {
	const requests: RecordedRequest[] = [];
	const received: ReceivedRequest[] = [];
	const connects: { authority: string; remoteAddress: string | undefined }[] = [];
	const tunnels = new Set<net.Socket>();

	const handler = (listener: string) => async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		const headers: [string, string][] = [];
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			if (recordedHeaders.has(req.rawHeaders[i].toLowerCase())) {
				headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
			}
		}
		requests.push({ listener, method: req.method ?? '', path: req.url ?? '', headers, remoteAddress: req.socket.remoteAddress ?? '', body: body.length <= 1024 ? body.toString('utf8') : { length: body.length } });

		const allHeaders: Record<string, string | string[]> = {};
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const name = req.rawHeaders[i].toLowerCase();
			const previous = allHeaders[name];
			allHeaders[name] = previous === undefined ? req.rawHeaders[i + 1] : [previous, req.rawHeaders[i + 1]].flat();
		}
		received.push({ listener, method: req.method ?? '', path: req.url ?? '', headers: allHeaders, body });

		const url = new URL(req.url ?? '/', 'http://fake');
		const [route, param] = url.pathname.split('/').filter(Boolean);
		const size = Number(param);

		switch (route) {
			case 'echo':
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end('{"ok":true}');
				return;
			case 'status':
				res.writeHead(size, { 'content-type': 'application/json' });
				res.end(`{"status":${size}}`);
				return;
			case 'hops':
				if (size > 0) {
					res.writeHead(302, { location: `/hops/${size - 1}` });
					res.end();
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end('{"ok":true}');
				return;
			case 'redirect':
				res.writeHead(Number(url.searchParams.get('status') ?? 302), { location: url.searchParams.get('to') ?? '/' });
				res.end();
				return;
			case 'stall-headers':
				return;
			case 'stall-body':
				res.writeHead(200, { 'content-type': 'application/json' });
				res.write('"partial');
				return;
			case 'bytes':
				res.writeHead(200, { 'content-type': 'application/json', 'content-length': size });
				res.end(jsonOfLength(size));
				return;
			case 'gzip': {
				const compressed = gzipSync(jsonOfLength(size));
				res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length });
				res.end(compressed);
				return;
			}
			case 'gzip-incompressible': {
				const compressed = gzipSync(incompressible(size));
				res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': compressed.length, 'x-compressed-length': compressed.length });
				res.end(compressed);
				return;
			}
			case 'text':
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.end('not json');
				return;
			case 'inbox':
				// 本家の signedPost は応答本文を読まないため、状態だけを返す。stall は応答しない。
				if (param === 'stall') {
					return;
				}
				res.writeHead(size);
				res.end();
				return;
			default:
				res.writeHead(404);
				res.end();
		}
	};

	const listen = async (server: net.Server, host: string) => {
		await new Promise<void>(resolve => server.listen(0, host, resolve));
		return (server.address() as net.AddressInfo).port;
	};

	const servers: { name: string; server: http.Server | https.Server }[] = [];
	const ports: Record<string, number> = {};

	for (const [name, host] of [['private', '127.0.0.1'], ['public', '127.0.0.2']] as const) {
		const server = http.createServer(handler(name));
		ports[name] = await listen(server, host);
		servers.push({ name, server });
	}

	// 自己署名の証明書を既定の信頼先へ足す。agent に ca を渡すと本家と違う設定になるため、プロセス全体の既定を変える。
	const material = createTlsMaterial();
	const defaultCa = tls.getCACertificates('default');
	if (material) {
		tls.setDefaultCACertificates([...defaultCa, material.cert]);
		for (const [name, host] of [['tlsPrivate', '127.0.0.1'], ['tlsPublic', '127.0.0.2']] as const) {
			const server = https.createServer(material, handler(name));
			ports[name] = await listen(server, host);
			servers.push({ name, server });
		}
	}

	const proxy = http.createServer((_req, res) => {
		res.writeHead(405);
		res.end();
	});
	proxy.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
		const authority = req.url ?? '';
		const separator = authority.lastIndexOf(':');
		const host = authority.slice(0, separator);
		connects.push({ authority, remoteAddress: client.remoteAddress });
		tunnels.add(client);

		// proxy 自身の名前解決も偽の DNS 表に従わせる。
		const target = net.connect(Number(authority.slice(separator + 1)), fakeNames[host] ?? host, () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			target.write(head);
			target.pipe(client);
			client.pipe(target);
		});
		tunnels.add(target);
		target.on('error', () => client.destroy());
		client.on('error', () => target.destroy());
	});
	ports.proxy = await listen(proxy, '127.0.0.1');

	const origins: Record<string, string> = {
		public: `http://public.outbound.test:${ports.public}`,
		publicIp: `http://127.0.0.2:${ports.public}`,
		sub: `http://sub.public.outbound.test:${ports.public}`,
		other: `http://other.outbound.test:${ports.public}`,
		private: `http://private.outbound.test:${ports.private}`,
		privateIp: `http://127.0.0.1:${ports.private}`,
		localhost: `http://localhost:${ports.private}`,
		proxy: `http://127.0.0.1:${ports.proxy}`,
	};
	if (material) {
		origins.tlsPublic = `https://public.outbound.test:${ports.tlsPublic}`;
		origins.tlsOther = `https://other.outbound.test:${ports.tlsPublic}`;
		origins.tlsPrivate = `https://private.outbound.test:${ports.tlsPrivate}`;
	}

	const expand = (value: string) => value.replace(/\{(\w+)\}/g, (whole, name: string) => origins[name] ?? whole);

	// 実行ごとに変わるポートを名前へ戻し、記録を比較できるようにする。
	const normalize = (value: string) => {
		let result = value;
		for (const [name, origin] of Object.entries(origins).sort((a, b) => b[1].length - a[1].length)) {
			result = result.replace(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'g'), `{${name}}`);
		}
		for (const [name, port] of Object.entries(ports)) {
			result = result.replace(new RegExp(`:${port}(?!\\d)`, 'g'), `:{port:${name}}`);
		}
		return result;
	};

	const describe = (error: unknown) => {
		const e = error as Record<string, unknown> & Error;
		return {
			name: e.name,
			message: normalize(String(e.message)),
			type: e.type,
			code: e.code,
			statusCode: e.statusCode,
			statusMessage: e.statusMessage,
			isClientError: e.isClientError,
			isRetryable: e.isRetryable,
		};
	};

	const summarize = (value: unknown) => (typeof value === 'string' ? { stringLength: value.length } : value);

	const toBody = (body: ProbeBody | undefined) => {
		switch (body?.kind) {
			case 'text':
				return body.value;
			case 'bytes':
				return new TextEncoder().encode(body.value);
			case 'urlencoded':
				return new URLSearchParams(body.fields);
			case 'form': {
				const form = new FormData();
				for (const [key, value] of Object.entries(body.fields)) {
					form.append(key, value);
				}
				return form;
			}
			default:
				return undefined;
		}
	};

	// multipart の boundary は送信ごとに変わるため、名前に置き換える。長さも変わるので content-length は残さない。
	const normalizeRequest = (request: RecordedRequest) => {
		const contentType = request.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
		const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
		if (!boundary) {
			return { ...request, path: normalize(request.path), headers: request.headers.map(([name, value]) => [name, normalize(value)]) };
		}
		return {
			...request,
			path: normalize(request.path),
			headers: request.headers
				.filter(([name]) => name.toLowerCase() !== 'content-length')
				.map(([name, value]) => [name, value.replaceAll(boundary, '{boundary}')]),
			body: typeof request.body === 'string' ? request.body.replaceAll(boundary, '{boundary}') : request.body,
		};
	};

	const settingsFor = (config: HttpCase['config']): ClientSettings => ({
		userAgent: probeUserAgent,
		allowedPrivateNetworks: config?.allowedPrivateNetworks ?? publicStandIn,
		proxy: config?.proxy ? origins.proxy : undefined,
		proxyBypassHosts: config?.proxyBypassHosts,
		outgoingAddress: config?.outgoingAddress,
	});

	const inboxRequest = (request: ReceivedRequest, publicKeyPem: string): InboxRequest => {
		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Object.entries(request.headers)) {
			if (!inboxHeaders.has(name)) {
				continue;
			}
			// 署名値は Host のポートで変わる。検証済みの結果を別に残し、値は名前へ置き換える。
			const settle = (v: string) => (name === 'signature' ? normalize(v).replace(/signature="[^"]*"/, 'signature="{signature}"') : normalize(v));
			headers[name] = Array.isArray(value) ? value.map(settle) : settle(value);
		}
		return {
			listener: request.listener,
			method: request.method,
			path: normalize(request.path),
			headers,
			body: request.body.toString('utf8'),
			verified: verifyReceived(request, publicKeyPem),
		};
	};

	return {
		tls: material !== null,
		expand,
		normalize,
		async run(c, client) {
			requests.length = 0;
			received.length = 0;
			connects.length = 0;

			const instance = client(settingsFor(c.config));
			const url = expand(c.url);
			const result: Record<string, unknown> = { id: c.id };

			try {
				if (c.op === 'getJson') {
					result.json = summarize(await instance.getJson(url, c.accept, c.headers));
				} else {
					const options = { ...c.options, headers: c.options?.headers, body: toBody(c.options?.body) };
					const response = await instance.send(url, options, c.extra ?? {});
					result.response = { status: response.status, statusText: response.statusText, finalUrl: normalize(response.finalUrl) };
					if (c.read) {
						try {
							result.body = summarize(c.read === 'json' ? await response.json() : await response.text());
						} catch (error) {
							result.readError = describe(error);
						}
					}
				}
			} catch (error) {
				result.error = describe(error);
			}

			result.requests = requests.map(normalizeRequest);
			result.connects = connects.map(entry => ({ ...entry, authority: normalize(entry.authority) }));
			return result;
		},
		async runInbox(c, post, publicKeyPem) {
			received.length = 0;

			let failure: { error: unknown } | null = null;
			try {
				await post(settingsFor(undefined), expand(c.url), c.object, c.digest);
			} catch (error) {
				failure = { error };
			}

			const observation: InboxObservation = { id: c.id, received: received.map(request => inboxRequest(request, publicKeyPem)) };
			if (failure) {
				observation.error = describe(failure.error);
			}
			return { observation, failure };
		},
		async close() {
			for (const socket of tunnels) {
				socket.destroy();
			}
			for (const { server } of servers) {
				server.closeAllConnections();
			}
			proxy.closeAllConnections();
			await Promise.all([...servers.map(({ server }) => server), proxy].map(server => new Promise(resolve => server.close(resolve))));
			if (material) {
				tls.setDefaultCACertificates(defaultCa);
			}
		},
	};
}

/** 偽の inbox が受け取った 1 件の配送。`verified` は受信した値のまま検証した結果。 */
export interface RecordedDelivery {
	receivedAt: number;
	path: string;
	headers: Record<string, string | string[]>;
	body: string;
	/** 署名ヘッダーの keyId。 */
	keyId: string | null;
	verify(publicKeyPem: string): { signature: boolean | null; digest: boolean | null };
}

export interface InboxRecorder {
	/** `http://127.0.0.1:<port>`。子プロセスからも名前解決なしで届く。 */
	origin: string;
	deliveries: RecordedDelivery[];
	/** path ごとの応答の状態。未指定は 202。 */
	respond(path: string, status: number): void;
	close(): Promise<void>;
}

/**
 * 複数の inbox への配送を受け取って記録する偽のサーバー。どの path にも応答し、署名と Digest は記録から後で検証する。
 * 実 DNS の差し替えが効かない子プロセスからも使えるよう、IP アドレスで待ち受ける。
 */
export async function startInboxRecorder(): Promise<InboxRecorder> {
	const deliveries: RecordedDelivery[] = [];
	const statuses = new Map<string, number>();
	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		const headers: Record<string, string | string[]> = {};
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const name = req.rawHeaders[i].toLowerCase();
			const previous = headers[name];
			headers[name] = previous === undefined ? req.rawHeaders[i + 1] : [previous, req.rawHeaders[i + 1]].flat();
		}
		const received: ReceivedRequest = { listener: 'inbox', method: req.method ?? '', path: req.url ?? '', headers, body: Buffer.concat(chunks) };
		deliveries.push({
			receivedAt: Date.now(),
			path: received.path,
			headers,
			body: received.body.toString('utf8'),
			keyId: /keyId="([^"]*)"/.exec(single(headers.signature) ?? '')?.[1] ?? null,
			verify: publicKeyPem => verifyReceived(received, publicKeyPem),
		});
		res.writeHead(statuses.get(received.path) ?? 202);
		res.end();
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

	return {
		origin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
		deliveries,
		respond(path, status) {
			statuses.set(path, status);
		},
		async close() {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		},
	};
}
