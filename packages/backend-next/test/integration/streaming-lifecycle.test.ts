/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { emptyStreamFacts } from '../../src/modules/stream/public.js';
import { openStreamingServer } from '../../src/platform/streaming-server.js';
import { closeHttp, listenHttp, registerHttpDrain } from '../../src/processes/http.js';
import { testConfig } from '../helpers/database.js';
import type { StreamingPorts } from '../../src/platform/streaming-server.js';

const logger = { info() {}, error() {} };
const delay = () => new Promise(resolve => setTimeout(resolve, 25));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
 resolve = done; 
});
	return { promise, resolve };
}

function ports(overrides: Partial<StreamingPorts> = {}): StreamingPorts {
	return { authenticate: async () => ({ userId: 'me', canReadAccount: true, isSuspended: false }), readFacts: async () => emptyStreamFacts('me'), hidingFollowing: async () => new Set(), repack: async () => null, reaction: async () => undefined, touchActivity: async () => {}, ...overrides };
}

async function start(port: StreamingPorts) {
	const config = testConfig();
	const server = await listenHttp(new Hono(), config.http);
	const stream = await openStreamingServer(server, { redis: config.redisForPubsub, selfUrl: config.url, ports: port, logger, onFailure: () => {} });
	registerHttpDrain(server, stream.close);
	const address = (server.address() as { port: number }).port;
	let closing: Promise<void> | undefined;
	return { server, address, close: () => closing ??= closeHttp(server) };
}

async function connect(address: number, autoPong = true) {
	const socket = new WebSocket(`ws://127.0.0.1:${address}/streaming?i=token`, { autoPong });
	const messages: any[] = [];
	socket.on('message', data => messages.push(JSON.parse(data.toString())));
	await new Promise<void>((resolve, reject) => {
 socket.once('open', resolve); socket.once('error', reject); 
});
	return { socket, messages };
}

afterEach(() => {
 vi.useRealTimers(); 
});

test.each(['guest', 'authenticated'] as const)('%s connections accept 1 MiB and reject oversized fragmented messages with 1009', async actor => {
	const running = await start(ports(actor === 'guest' ? { authenticate: async () => null, readFacts: async () => emptyStreamFacts(null) } : {}));
	const client = await connect(running.address);
	const redis = new Redis(testConfig().redis);
	const limit = 1024 * 1024;
	try {
		const command = JSON.stringify({ type: 'subNote', body: { id: 'payload-boundary' } });
		client.socket.send(command.padEnd(limit, ' '));
		const event = { channel: 'noteStream:payload-boundary', message: { type: 'deleted', body: { id: 'payload-boundary', userId: 'a', visibility: 'public', body: {} } } };
		await vi.waitFor(async () => {
			await redis.publish('example.test', JSON.stringify(event));
			expect(client.messages).toContainEqual({ type: 'noteUpdated', body: { id: 'payload-boundary', type: 'deleted', body: {} } });
		});
		let code: number | undefined;
		client.socket.once('close', value => {
			code = value;
		});
		client.socket.send(' '.repeat(limit), { fin: false });
		client.socket.send(' ', { fin: true });
		await vi.waitFor(() => expect(code).toBe(1009));
	} finally {
		redis.disconnect();
		client.socket.terminate();
		await running.close();
	}
});

test('heartbeat pings at each minute and terminates only when the last pong is more than two minutes old', async () => {
	vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
	const running = await start(ports());
	const client = await connect(running.address, false);
	let pings = 0;
	client.socket.on('ping', () => {
 pings++; 
});
	try {
		await vi.advanceTimersByTimeAsync(60000); await delay();
		expect(pings).toBe(1);
		await vi.advanceTimersByTimeAsync(60000); await delay();
		expect(pings).toBe(2);
		expect(client.socket.readyState).toBe(WebSocket.OPEN);
		await vi.advanceTimersByTimeAsync(60000); await delay();
		expect(client.socket.readyState).toBe(WebSocket.CLOSED);
	} finally {
 client.socket.terminate(); await running.close(); 
}
});

test('pong keeps a client alive, activity repeats at five minutes, and close stops timers and subscriber', async () => {
	vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
	let activity = 0;
	let reads = 0;
	const running = await start(ports({ readFacts: async () => {
 reads++; return emptyStreamFacts('me'); 
}, touchActivity: async () => {
 activity++; 
} }));
	const client = await connect(running.address);
	try {
		for (let minute = 0; minute < 5; minute++) {
			await vi.advanceTimersByTimeAsync(60000); await delay();
		}
		expect(client.socket.readyState).toBe(WebSocket.OPEN);
		expect(activity).toBe(2);
		expect(reads).toBe(31);
		await running.close();
		const count = reads;
		await vi.advanceTimersByTimeAsync(600000);
		expect(activity).toBe(2);
		expect(reads).toBe(count);
		const redis = new Redis(testConfig().redis);
		try {
			expect(String(await redis.client('LIST'))).not.toContain(`${testConfig().redis.prefix}:posting-stream`);
		} finally {
 redis.disconnect(); 
}
	} finally {
 client.socket.terminate(); await running.close(); 
}
});

test('shutdown destroys an authenticating upgrade socket and waits for its outstanding database read', async () => {
	const accepted = deferred<void>();
	const authentication = deferred<{ userId: string; canReadAccount: boolean; isSuspended: boolean }>();
	const running = await start(ports({ authenticate: async () => {
 accepted.resolve(); return authentication.promise; 
} }));
	const socket = new WebSocket(`ws://127.0.0.1:${running.address}/streaming?i=token`);
	socket.on('error', () => {});
	await accepted.promise;
	let drained = false;
	const closing = running.close().then(() => {
 drained = true; 
});
	await delay();
	expect(drained).toBe(false);
	authentication.resolve({ userId: 'me', canReadAccount: true, isSuspended: false });
	await closing;
	expect(socket.readyState).toBe(WebSocket.CLOSED);
});

test('shutdown with a pending hidden main render waits before releasing dependencies', async () => {
	const rendering = deferred<void>();
	const rendered = deferred<Record<string, unknown> | null>();
	const running = await start(ports({ repack: async () => {
 rendering.resolve(); return rendered.promise; 
} }));
	const client = await connect(running.address);
	const redis = new Redis(testConfig().redis);
	try {
		client.socket.send(JSON.stringify({ type: 'connect', body: { id: 'm', channel: 'main', pong: true } }));
		await vi.waitFor(() => expect(client.messages).toHaveLength(1));
		await redis.publish('example.test', JSON.stringify({ channel: 'mainStream:me', message: { type: 'notification', body: { note: { id: 'n', isHidden: true } } } }));
		await rendering.promise;
		let drained = false;
		const closing = running.close().then(() => {
 drained = true; 
});
		await delay(); expect(drained).toBe(false);
		rendered.resolve({ id: 'n', text: 'private' });
		await closing;
		expect(client.messages).toHaveLength(1);
	} finally {
 redis.disconnect(); client.socket.terminate(); await running.close(); 
}
});
