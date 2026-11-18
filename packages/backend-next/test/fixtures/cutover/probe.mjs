/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { connect } from 'node:net';

async function connectionResult(host, port) {
	return new Promise(resolve => {
		const socket = connect({ host, port });
		const finish = result => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(2000, () => finish('TIMEOUT'));
		socket.once('connect', () => finish('connected'));
		socket.once('error', error => finish(error.code));
	});
}

assert.equal(await connectionResult('postgres', 5432), 'connected');
for (const host of ['redis', 'redis-pubsub', 'redis-jobs', 'redis-timelines', 'redis-reactions']) {
	assert.equal(await connectionResult(host, 6379), 'connected');
}
// Literal public addresses exercise routing without mistaking a DNS failure for isolation.
for (const [host, port] of [['1.1.1.1', 443], ['8.8.8.8', 53]]) {
	assert.equal(await connectionResult(host, port), 'ENETUNREACH');
}
console.log('CUTOVER_FIXTURE_NETWORK_OK');
