/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { openStreamingServer } from '../../built/platform/streaming-server.js';
let release;
const gate = new Promise(resolve => {
 release = resolve; 
});
let entered;
const authenticating = new Promise(resolve => {
 entered = resolve; 
});
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const uncaught = [];
process.on('uncaughtException', error => {
 uncaught.push(error.code ?? error.message); 
});
const streaming = await openStreamingServer(server, {
 redis: { host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_REDIS_PORT ?? 56379), prefix: 'streaming-reset-test', db: 0 }, selfUrl: 'http://ws173-review.invalid',
 logger: { error() {} }, onFailure(error) {
 throw error; 
},
 ports: { authenticate: async () => {
 entered(); await gate; return null; 
}, readFacts: async () => ({ userId: null }), hidingFollowing: async () => new Set(), repack: async () => null, reaction: async () => undefined, touchActivity: async () => {} }
});
const client = connect(server.address().port, '127.0.0.1');
await new Promise(resolve => client.once('connect', resolve));
client.write('GET /streaming HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
await authenticating;
client.resetAndDestroy();
await new Promise(resolve => setTimeout(resolve, 100));
console.log(JSON.stringify({ uncaughtDuringAuthentication: uncaught }));
release();
await streaming.close();
await new Promise(resolve => server.close(resolve));
