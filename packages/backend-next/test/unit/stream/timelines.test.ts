/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createStreamConnection, emptyStreamFacts } from '../../../src/modules/stream/public.js';

const corpus = JSON.parse(
	readFileSync(
		new URL('../../../../../docs/superpowers/compatibility/stream/timelines/source-cases.json', import.meta.url),
		'utf8',
	),
);

for (const record of corpus.observations) {
	test(`fixed upstream timelines: ${record.id}`, async () => {
		const { channel, facts: original, params, payload } = record.input;
		const snapshot = structuredClone(payload);
		const facts = {
			...emptyStreamFacts(original.user?.id ?? null),
			following: new Map<string, { withReplies: boolean }>(Object.entries(original.following)),
			followingChannels: new Set<string>(original.followingChannels),
			mutedChannels: new Set<string>(original.mutingChannels),
			mutedUsers: new Set<string>(original.muting),
			blockingUsers: new Set<string>(original.blockingMe),
			renoteMutedUsers: new Set<string>(original.renoteMuting),
			mutedInstances: new Set<string>(original.mutedInstances),
			ugcVisibilityForVisitor: original.ugc,
		};
		const sent: unknown[] = [];
		const stream = createStreamConnection({
			facts: () => facts,
			now: () => Date.parse('2026-11-07T00:00:00.000Z'),
			timelinePolicies: async () => original.policies,
			hidingFollowing: async () => new Set(Object.keys(original.hidingFollowing ?? original.following)),
			send: (value) => sent.push(JSON.parse(JSON.stringify(value))),
			repack: async () => {
				throw new Error('Hashtag must preserve published snapshots');
			},
			reaction: async () => ':own:',
		});
		await stream.receive({ type: 'connect', body: { id: 'channel-id', channel, params, pong: true } });
		expect(sent).toEqual([{ type: 'connected', body: { id: 'channel-id' } }]);
		expect(record.disposedListeners).toBe(0);
		sent.length = 0;
		await stream.publish({ channel: 'notesStream', message: payload });
		expect(sent).toEqual(record.sent);
		expect(payload).toEqual(snapshot);
	});
}

test('timeline permissions are read for each subscription and denied subscriptions stay dormant until replaced', async () => {
	let allowed = false;
	const sent: any[] = [];
	const stream = createStreamConnection({ facts: () => emptyStreamFacts('viewer'), now: () => 0, send: value => sent.push(value), repack: async () => null, reaction: async () => undefined,
																																									timelinePolicies: async () => ({ ltlAvailable: allowed, gtlAvailable: allowed }),
	});
	const payload = corpus.observations[0].input.payload;
	await stream.receive({ type: 'connect', body: { id: 't', channel: 'localTimeline', pong: true } });
	expect(sent).toEqual([{ type: 'connected', body: { id: 't' } }]);
	allowed = true;
	await stream.publish({ channel: 'notesStream', message: payload });
	expect(sent).toHaveLength(1);
	await stream.receive({ type: 'connect', body: { id: 't', channel: 'localTimeline' } });
	await stream.publish({ channel: 'notesStream', message: payload });
	expect(sent).toHaveLength(2);
	await stream.receive({ type: 'disconnect', body: { id: 't' } });
	await stream.publish({ channel: 'notesStream', message: payload });
	expect(sent).toHaveLength(2);
});

test('asynchronous initialization cannot acknowledge or restore a disconnected, replaced, or disposed channel', async () => {
	for (const action of ['disconnect', 'replace', 'dispose']) {
		let resolve!: (policies: { ltlAvailable: boolean; gtlAvailable: boolean }) => void;
		const sent: unknown[] = [];
		const stream = createStreamConnection({ facts: () => emptyStreamFacts('viewer'), now: () => 0, send: value => sent.push(value), repack: async () => null, reaction: async () => undefined,
																																										timelinePolicies: () => new Promise(done => {
																																											resolve = done;
																																										}),
		});
		const pending = stream.receive({ type: 'connect', body: { id: 't', channel: 'localTimeline', pong: true } });
		if (action === 'dispose') {
			stream.dispose();
		} else if (action === 'replace') {
			await stream.receive({ type: 'connect', body: { id: 't', channel: 'homeTimeline' } });
		} else {
			await stream.receive({ type: 'disconnect', body: { id: 't' } });
		}
		resolve({ ltlAvailable: true, gtlAvailable: true });
		await pending;
		await stream.publish({ channel: 'notesStream', message: corpus.observations[0].input.payload });
		expect(sent).toEqual([]);
	}
});

test('malformed params keep the current subscription and guest hybrid authorization is rejected before policy lookup', async () => {
	let reads = 0;
	const sent: any[] = [];
	const stream = createStreamConnection({ facts: () => emptyStreamFacts(null), now: () => 0, send: value => sent.push(value), repack: async () => null, reaction: async () => undefined,
																																									timelinePolicies: async () => {
																																										reads++; return { ltlAvailable: true, gtlAvailable: true };
																																									},
	});
	await stream.receive({ type: 'connect', body: { id: 't', channel: 'globalTimeline' } });
	for (const params of [null, [], 1, 'bad']) {
		await stream.receive({ type: 'connect', body: { id: 't', channel: 'globalTimeline', params, pong: true } });
	}
	await stream.receive({ type: 'connect', body: { id: 'denied', channel: 'hybridTimeline', pong: true } });
	expect(reads).toBe(1);
	await stream.publish({ channel: 'notesStream', message: corpus.observations[0].input.payload });
	expect(sent).toHaveLength(1);
	stream.dispose();
	await stream.publish({ channel: 'notesStream', message: corpus.observations[0].input.payload });
	expect(sent).toHaveLength(1);
});

