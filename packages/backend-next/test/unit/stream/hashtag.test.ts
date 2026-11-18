/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createStreamConnection, emptyStreamFacts, type StreamNote } from '../../../src/modules/stream/public.js';

const corpus = JSON.parse(
	readFileSync(
		new URL('../../../../../docs/superpowers/compatibility/stream/hashtag/source-cases.json', import.meta.url),
		'utf8',
	),
);

for (const record of corpus.observations) {
	test(`fixed upstream hashtag: ${record.id}`, async () => {
		const { facts: original, params, payload } = record.input;
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
			hidingFollowing: async () => new Set(Object.keys(original.hidingFollowing ?? original.following)),
			send: (value) => sent.push(JSON.parse(JSON.stringify(value))),
			repack: async () => {
				throw new Error('Hashtag must preserve published snapshots');
			},
			reaction: async () => ':own:',
		});
		await stream.receive({ type: 'connect', body: { id: 'channel-id', channel: 'hashtag', params, pong: true } });
		expect(sent).toEqual(record.accepted ? [{ type: 'connected', body: { id: 'channel-id' } }] : []);
		sent.length = 0;
		await stream.publish({ channel: 'notesStream', message: payload });
		expect(sent).toEqual(record.sent);
		expect(payload).toEqual(snapshot);
	});
}

test('hashtag subscriptions remain independent and disconnect removes delivery including pending reactions', async () => {
	const facts = emptyStreamFacts('viewer');
	const sent: any[] = [];
	let finish!: (reaction: string) => void;
	let started!: () => void;
	const pending = new Promise<void>((resolve) => {
		started = resolve;
	});
	const stream = createStreamConnection({
		facts: () => facts,
		now: () => 0,
		send: (value) => sent.push(value),
		repack: async () => null,
		reaction: async () => {
			started();
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		},
	});
	for (const [id, tag] of [
		['first', 'misskey'],
		['second', 'other'],
	]) {
		await stream.receive({ type: 'connect', body: { id, channel: 'hashtag', params: { q: [[tag]] } } });
	}
	const note = {
		id: 'n',
		createdAt: '2026-11-07T00:00:00.000Z',
		userId: 'author',
		user: { id: 'author' },
		text: 'hello',
		visibility: 'public',
		tags: ['misskey'],
	} as StreamNote;
	await stream.publish({ channel: 'otherStream', message: note });
	expect(sent).toEqual([]);
	await stream.publish({ channel: 'notesStream', message: note });
	expect(sent.map((value) => value.body.id)).toEqual(['first']);
	sent.length = 0;
	const publishing = stream.publish({
		channel: 'notesStream',
		message: { ...note, text: null, renoteId: 'r', renote: { ...note, id: 'r', reactions: { like: 1 } } },
	});
	await pending;
	await stream.receive({ type: 'disconnect', body: { id: 'first' } });
	finish(':own:');
	await publishing;
	await stream.publish({ channel: 'notesStream', message: note });
	expect(sent).toEqual([]);
	stream.dispose();
	await stream.publish({ channel: 'notesStream', message: { ...note, tags: ['other'] } });
	expect(sent).toEqual([]);
});

test('invalid queries free subscription capacity and replace an existing subscription without an acknowledgement', async () => {
	const sent: unknown[] = [];
	const stream = createStreamConnection({
		facts: () => emptyStreamFacts(null),
		now: () => 0,
		send: (value) => sent.push(value),
		repack: async () => null,
		reaction: async () => undefined,
	});
	for (let index = 0; index < 40; index++) {
		await stream.receive({
			type: 'connect',
			body: { id: String(index), channel: 'hashtag', params: { q: [[]] }, pong: true },
		});
	}
	await stream.receive({
		type: 'connect',
		body: { id: 'valid', channel: 'hashtag', params: { q: [['tag']] }, pong: true },
	});
	expect(sent).toEqual([{ type: 'connected', body: { id: 'valid' } }]);
	await stream.receive({ type: 'connect', body: { id: 'valid', channel: 'hashtag', params: { q: null }, pong: true } });
	await stream.publish({
		channel: 'notesStream',
		message: { id: 'note', tags: ['tag'], userId: 'author', user: { id: 'author' }, visibility: 'public' },
	});
	expect(sent).toHaveLength(1);
});
