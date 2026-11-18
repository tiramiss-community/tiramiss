/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { connect } from 'node:net';

async function reachable(host, port) {
	return new Promise(resolve => {
		const socket = connect({ host, port });
		const finish = result => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(2000, () => finish(false));
		socket.once('connect', () => finish(true));
		socket.once('error', () => finish(false));
	});
}

assert.equal(await reachable('postgres', 5432), true);
for (const host of ['redis', 'redis-pubsub', 'redis-jobs', 'redis-timelines', 'redis-reactions']) {
	assert.equal(await reachable(host, 6379), true);
}
// Literal public addresses exercise routing without mistaking a DNS failure for isolation.
for (const [host, port] of [['1.1.1.1', 443], ['8.8.8.8', 53]]) {
	assert.equal(await reachable(host, port), false);
}
console.log('CUTOVER_FIXTURE_NETWORK_OK');
