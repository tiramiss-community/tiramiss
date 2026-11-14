/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createOutboundHttpClient } from '../../src/composition/outbound-http.js';
import { createPreviewFetcher } from '../../src/platform/url-preview.js';
import { createUrlPreview } from '../../src/modules/url-preview/preview.js';
import { createUrlPreviewApi } from '../../src/http/url-preview-api.js';
import type { PreviewSettings } from '../../src/modules/url-preview/preview.js';
import type { OutboundHttpConfig } from '../../src/config/types.js';

const baseSettings: PreviewSettings = {
	urlPreviewEnabled: true, urlPreviewAllowRedirect: false, urlPreviewTimeout: 1000,
	urlPreviewMaximumContentLength: 10485760, urlPreviewRequireContentLength: false,
	urlPreviewSummaryProxyUrl: null, urlPreviewUserAgent: null, urlPreviewSensitiveList: [],
};
const received: { method: string; path: string; ua?: string; lang?: string; remote?: string }[] = [];
const tunnels: { target: string; remote?: string }[] = [];
const servers: (http.Server | https.Server)[] = [];
const sockets = new Set<net.Socket>();
let origin: string;
let secure: string;
let proxyUrl: string;
let cert: string;
let releaseDelayed: (() => void) | undefined;
const listen = async (server: http.Server | https.Server) => {
	servers.push(server);
	server.on('connection', socket => {
		sockets.add(socket); socket.on('close', () => sockets.delete(socket)); 
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as net.AddressInfo).port;
};
const page = '<html><head><title>Actual Summaly page</title><meta name="description" content="Description"><meta property="og:image" content="/picture.png"></head><body>hello</body></html>';
const result = { url: 'https://result.test/path', title: 'Proxy summary', player: { url: null }, icon: 'https://img.test/i', thumbnail: null };
const handler: http.RequestListener = (request, response) => {
	const url = new URL(request.url!, 'http://local');
	received.push({ method: request.method!, path: request.url!, ua: request.headers['user-agent'], lang: request.headers['accept-language'], remote: request.socket.remoteAddress });
	if (url.pathname === '/redirect') {
		response.writeHead(302, { Location: '/page' }); response.end(); return; 
	}
	if (url.pathname === '/disconnect') {
		request.socket.destroy(); return; 
	}
	if (url.pathname === '/held') {
		releaseDelayed = () => {
			if (!response.headersSent) {
				response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(page) }); response.end(page); 
			} 
		};
		return;
	}
	if (url.pathname.startsWith('/summary')) {
		const finish = () => {
			response.setHeader('Content-Type', 'application/json'); response.end(url.pathname === '/summary-big' ? JSON.stringify({ ...result, title: 'x'.repeat(262144) }) : JSON.stringify(result)); 
		};
		if (url.pathname === '/summary-slow') {
			const timer = setTimeout(finish, 5500); response.on('close', () => clearTimeout(timer)); 
		} else {
			finish();
		}
		return;
	}
	if (url.pathname === '/fail') {
		response.writeHead(500); response.end('failed'); return; 
	}
	if (url.pathname === '/delay') {
		const timer = setTimeout(() => {
			response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(page); 
		}, 200); response.on('close', () => clearTimeout(timer)); return; 
	}
	if (url.pathname.endsWith('.png') || url.pathname === '/favicon.ico') {
		response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 1 }); response.end('i'); return; 
	}
	response.setHeader('Content-Type', 'text/html');
	if (url.pathname === '/chunked') {
		response.setHeader('Transfer-Encoding', 'chunked');
	} else {
		response.setHeader('Content-Length', Buffer.byteLength(page));
	}
	response.end(page);
};
beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'preview377-tls-'));
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=preview.test', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
		cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
		secure = `https://127.0.0.1:${await listen(https.createServer({ cert, key: readFileSync(join(dir, 'key.pem')) }, handler))}`;
	} finally {
		rmSync(dir, { recursive: true, force: true }); 
	}
	origin = `http://127.0.0.1:${await listen(http.createServer(handler))}`;
	const proxy = http.createServer();
	proxy.on('connect', (request, downstream, head) => {
		tunnels.push({ target: request.url!, remote: (downstream as net.Socket).remoteAddress });
		const target = new URL(`http://${request.url}`);
		const upstream = net.connect(Number(target.port), target.hostname, () => {
			downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) {
				upstream.write(head);
			}
			downstream.pipe(upstream); upstream.pipe(downstream);
		});
		sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
		upstream.on('error', () => downstream.destroy()); downstream.on('error', () => upstream.destroy());
		downstream.on('close', () => upstream.destroy());
	});
	proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});
afterAll(async () => {
	for (const socket of sockets) {
		socket.destroy();
	}
	await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

async function withPreview(config: OutboundHttpConfig, settings: Partial<PreviewSettings>, work: (app: ReturnType<typeof createUrlPreviewApi>, client: ReturnType<typeof createOutboundHttpClient>) => Promise<void>) {
	const client = createOutboundHttpClient({ userAgent: 'Misskey/probe (https://self.test)', outboundHttp: config }, { checkPrivateAddress: true });
	client.defaultAgents().https.options.ca = cert;
	const preview = createUrlPreview({
		readSettings: async () => ({ ...baseSettings, ...settings }),
		fetchSummary: createPreviewFetcher({ url: 'https://self.test', agents: client.defaultAgents(), getJson: client.getJson }),
		mediaProxy: 'https://self.test/proxy', now: Date.now,
	});
	try {
		await work(createUrlPreviewApi(preview), client); 
	} finally {
		await preview.close(); await client.close(); 
	}
}

const request = (app: ReturnType<typeof createUrlPreviewApi>, url: string, lang?: string) => app.request(`/url?url=${encodeURIComponent(url)}${lang === undefined ? '' : `&lang=${encodeURIComponent(lang)}`}`);

test.each(['http', 'https'])('direct real Summaly %s uses allowedPrivateNetworks, User-Agent, language and outgoingAddress', async protocol => {
	const target = protocol === 'http' ? origin : secure;
	await withPreview({ allowedPrivateNetworks: ['127.0.0.1/32'], outgoingAddress: '127.0.0.2' }, { urlPreviewUserAgent: 'Preview custom UA' }, async app => {
		const start = received.length;
		const response = await request(app, `${target}/page`, 'en-US');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ title: 'Actual Summaly page', url: `${target}/page`, sensitive: false });
		expect(received.slice(start)).toContainEqual(expect.objectContaining({ method: 'GET', path: '/page', ua: 'Preview custom UA', lang: 'en-US', remote: '127.0.0.2' }));
	});
});
test('direct defaults use Summaly version UA and ja-JP', async () => {
	await withPreview({ allowedPrivateNetworks: ['127.0.0.1/32'] }, {}, async app => {
		const start = received.length;
		expect((await request(app, `${origin}/page`)).status).toBe(200);
		expect(received.slice(start)).toContainEqual(expect.objectContaining({ path: '/page', ua: 'SummalyBot/5.5.2 (https://self.test; +https://github.com/misskey-dev/summaly/blob/master/README.md)', lang: 'ja-JP' }));
	});
});
test('direct private addresses are blocked without allowance', async () => {
	await withPreview({}, {}, async app => {
		expect((await request(app, `${origin}/page`)).status).toBe(422); 
	});
});
test.each(['http', 'https'])('direct %s uses configured CONNECT proxy even for listed bypass host', async protocol => {
	await withPreview({ proxy: proxyUrl, proxyBypassHosts: ['127.0.0.1'], outgoingAddress: '127.0.0.2' }, {}, async app => {
		const start = tunnels.length;
		expect((await request(app, `${protocol === 'http' ? origin : secure}/page`)).status).toBe(200);
		// hpagent 1.2.0 does not forward Agent.localAddress into its CONNECT request, as in the fixed upstream.
		expect(tunnels.slice(start)).toContainEqual({ target: new URL(protocol === 'http' ? origin : secure).host, remote: '127.0.0.1' });
	});
});
test.each([true, false])('actual Summaly redirect allow=$allow', async allow => {
	await withPreview({ allowedPrivateNetworks: ['127.0.0.1/32'] }, { urlPreviewAllowRedirect: allow }, async app => {
		const response = await request(app, `${origin}/redirect`);
		expect(response.status).toBe(allow ? 200 : 422);
		if (allow) {
			expect(await response.json()).toHaveProperty('url', `${origin}/page`);
		}
	});
});
test.each([
	{ path: '/page', settings: { urlPreviewMaximumContentLength: 20 } },
	{ path: '/chunked', settings: { urlPreviewRequireContentLength: true } },
	{ path: '/delay', settings: { urlPreviewTimeout: 30 } },
	{ path: '/fail', settings: {} },
	{ path: '/disconnect', settings: {} },
])('actual acquisition failure $path $settings becomes 422', async item => {
	await withPreview({ allowedPrivateNetworks: ['127.0.0.1/32'] }, item.settings, async app => {
		expect((await request(app, `${origin}${item.path}`)).status).toBe(422);
	});
});
test.each([false, true])('summary proxy settings are encoded and local address allowed; bypass=$bypass', async bypass => {
	await withPreview({ proxy: proxyUrl, ...(bypass ? { proxyBypassHosts: ['127.0.0.1'] } : {}), outgoingAddress: '127.0.0.2' }, {
		urlPreviewSummaryProxyUrl: `${origin}/summary`, urlPreviewUserAgent: 'Custom UA +', urlPreviewAllowRedirect: true,
		urlPreviewTimeout: 7, urlPreviewMaximumContentLength: 8, urlPreviewRequireContentLength: true,
	}, async app => {
		const start = tunnels.length; const receivedStart = received.length;
		const response = await request(app, 'https://input.test/a?x=1&y=2', '');
		expect(response.status).toBe(200);
		const record = received.slice(receivedStart).find(entry => entry.path.startsWith('/summary'))!;
		expect(record.ua).toBe('Misskey/probe (https://self.test)');
		expect(Object.fromEntries(new URL(record.path, origin).searchParams)).toEqual({ url: 'https://input.test/a?x=1&y=2', lang: '', followRedirects: 'true', userAgent: 'Custom UA +', operationTimeout: '7', contentLengthLimit: '8', contentLengthRequired: 'true' });
		expect(tunnels.length > start).toBe(!bypass);
		if (bypass) {
			expect(record.remote).toBe('127.0.0.2');
		}
	});
});
test('summary proxy without network proxy permits private endpoint and still enforces fixed 256KiB response limit', async () => {
	await withPreview({}, { urlPreviewSummaryProxyUrl: `${origin}/summary-big` }, async app => {
		expect((await request(app, 'https://input.test')).status).toBe(422);
	});
});
test('summary proxy TLS uses configured CONNECT transport and generic Misskey User-Agent', async () => {
	await withPreview({ proxy: proxyUrl }, { urlPreviewSummaryProxyUrl: `${secure}/summary` }, async app => {
		const start = tunnels.length; const receivedStart = received.length;
		expect((await request(app, 'https://input.test')).status).toBe(200);
		expect(tunnels.slice(start)).toContainEqual(expect.objectContaining({ target: new URL(secure).host }));
		expect(received.slice(receivedStart)).toContainEqual(expect.objectContaining({ ua: 'Misskey/probe (https://self.test)' }));
	});
});
test('summary proxy actual timeout is fixed five seconds despite requested operationTimeout', async () => {
	await withPreview({}, { urlPreviewSummaryProxyUrl: `${origin}/summary-slow`, urlPreviewTimeout: 1 }, async app => {
		const start = Date.now();
		expect((await request(app, 'https://input.test')).status).toBe(422);
		expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
	});
});
test('preview shutdown drains real Summaly acquisition before destroying agents', async () => {
	const client = createOutboundHttpClient({ userAgent: 'test', outboundHttp: { allowedPrivateNetworks: ['127.0.0.1/32'] } }, { checkPrivateAddress: true });
	const preview = createUrlPreview({ readSettings: async () => baseSettings, fetchSummary: createPreviewFetcher({ url: 'https://self.test', agents: client.defaultAgents(), getJson: client.getJson }), mediaProxy: 'https://self.test/proxy', now: Date.now });
	try {
		releaseDelayed = undefined;
		const pending = preview.preview(`${origin}/held`);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				clearInterval(poll); reject(new Error('held request did not arrive')); 
			}, 2000);
			const poll = setInterval(() => {
				if (releaseDelayed) {
					clearTimeout(timer); clearInterval(poll); resolve(); 
				} 
			}, 5);
		});
		let done = false;
		const close = preview.close().then(() => {
			done = true; 
		});
		await new Promise(resolve => setTimeout(resolve, 10)); expect(done).toBe(false);
		releaseDelayed!(); expect(await pending).toHaveProperty('title', 'Actual Summaly page');
		await close;
	} finally {
		releaseDelayed?.(); await preview.close(); await client.close(); 
	}
});
