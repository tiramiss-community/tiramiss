/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { startRemotePeer } from './remote-peer.js';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { PeerReply } from './remote-peer.js';

async function port(server: Server): Promise<number> {
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as { port: number }).port;
}

export async function startMetadataPeer() {
	const directory = await mkdtemp(join(tmpdir(), 'metadata-peer-'));
	const certPath = join(directory, 'cert.pem');
	const keyPath = join(directory, 'key.pem');
	// A missing TLS tool must fail acceptance, never produce a passing timestamp-only test.
	execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=remote.test', '-addext', 'subjectAltName=DNS:remote.test'], { stdio: 'ignore' });
	const cert = await readFile(certPath, 'utf8');
	const previous = getCACertificates('default');
	setDefaultCACertificates([...previous, cert]);
	const actor = await startRemotePeer();
	const requests: { method: string; path: string; accept?: string }[] = [];
	let respond = async (_path: string): Promise<PeerReply> => ({ status: 404 });
	const tls = createTlsServer({ key: await readFile(keyPath), cert }, (req, res) => {
		requests.push({ method: req.method!, path: req.url!, accept: req.headers.accept });
		void respond(req.url!).then(reply => {
			res.writeHead(reply.status ?? 200, { 'Content-Type': reply.type ?? 'application/json', ...reply.headers });
			res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
		}).catch(error => {
			res.writeHead(500); res.end(String(error));
		});
	});
	const tlsPort = await port(tls);
	const tunnels = new Set<Socket>();
	const proxy = createServer();
	proxy.on('connect', (req, socket, head) => {
		const client = socket as Socket;
		const encrypted = req.url?.endsWith(':443');
		const upstream = connect(encrypted ? tlsPort : Number(new URL(actor.proxy).port), '127.0.0.1', () => {
			if (encrypted) {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			} else {
				upstream.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
			}
			upstream.write(head); upstream.pipe(client); client.pipe(upstream);
		});
		for (const connection of [client, upstream]) {
			tunnels.add(connection); connection.on('close', () => tunnels.delete(connection));
		}
		upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
	});
	const proxyPort = await port(proxy);
	return {
		actor, certPath, requests, proxy: `http://127.0.0.1:${proxyPort}`,
		respond(handler: typeof respond) {
			respond = handler;
		},
		async close() {
			for (const connection of tunnels) {
				connection.destroy();
			}
			tls.closeAllConnections(); proxy.closeAllConnections();
			await Promise.all([new Promise<void>(resolve => tls.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
			await actor.close(); setDefaultCACertificates(previous); await rm(directory, { recursive: true, force: true });
		},
	};
}

export function metadataReply(path: string): PeerReply {
	if (path === '/.well-known/nodeinfo') {
		return { body: { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://remote.test/nodeinfo/2.1' }] } };
	}
	if (path === '/nodeinfo/2.1') {
		return { body: { software: { name: 'MiSsKeY', version: '2026.1' }, openRegistrations: true, metadata: { nodeName: 'Real HTTPS peer', nodeDescription: 'Actual metadata', themeColor: 'red', maintainer: { name: 'Maintainer', email: 'm@example.test' } } } };
	}
	if (path === '/') {
		return { type: 'text/html', body: '<link rel="icon" href="/favicon.png"><meta property="og:title" content="HTML name">' };
	}
	if (path === '/manifest.json') {
		return { body: { name: 'Manifest', icons: [{ src: '/manifest.png' }] } };
	}
	return { status: 404 };
}
export const expectedMetadata = { name: 'Real HTTPS peer', description: 'Actual metadata', softwareName: 'misskey', softwareVersion: '2026.1', openRegistrations: true, maintainerName: 'Maintainer', maintainerEmail: 'm@example.test', themeColor: '#ff0000', iconUrl: 'https://remote.test/manifest.png', faviconUrl: 'https://remote.test/favicon.png' };
