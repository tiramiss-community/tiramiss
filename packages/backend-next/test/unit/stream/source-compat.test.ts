/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createStreamConnection, emptyStreamFacts, hideStreamNote } from '../../../src/modules/stream/public.js';
import type { StreamFacts, StreamNote } from '../../../src/modules/stream/public.js';

const oracle = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/stream/source-cases.json', import.meta.url), 'utf8'));
const copy = (value: unknown) => JSON.parse(JSON.stringify(value));

function facts(input: any): StreamFacts {
	return { userId: input.user?.id ?? null, following: new Map(Object.entries(input.following)), followingChannels: new Set(input.followingChannels), mutedChannels: new Set(input.mutingChannels), mutedUsers: new Set(input.muting), blockingUsers: new Set(input.blockingMe), renoteMutedUsers: new Set(input.renoteMuting), mutedInstances: new Set(input.mutedInstances), ugcVisibilityForVisitor: input.ugc };
}

function connection(f: StreamFacts, original?: any) {
	const sent: unknown[] = [];
	const stream = createStreamConnection({ facts: () => f, now: () => Date.parse('2026-11-07T00:00:00.000Z'), send: value => sent.push(copy(value)),
		hidingFollowing: async () => new Set(Object.keys(original?.hidingFollowing ?? original?.following ?? Object.fromEntries(f.following))),
		repack: async id => ({ id, oracleRepacked: true, viewer: f.userId, detail: true }), reaction: async () => ':own:' });
	return { stream, sent };
}

for (const record of oracle.observations) {
	test(`fixed upstream: ${record.id}`, async () => {
		if (record.kind === 'channel') {
			const { channel, params, payload, facts: inputFacts } = record.input;
			const { stream, sent } = connection(facts(inputFacts), inputFacts);
			await stream.receive({ type: 'connect', body: { id: 'channel-id', channel, params } });
			await stream.publish({ channel: channel === 'main' ? `mainStream:${inputFacts.user?.id}` : 'notesStream', message: copy(payload) });
			expect(sent).toEqual(record.sent);
		} else if (record.kind === 'channelFailure') {
			let count = 0;
			const sent: unknown[] = [];
			const stream = createStreamConnection({ facts: () => facts(record.input.facts), now: () => Date.parse('2026-11-07T00:00:00.000Z'), send: value => sent.push(copy(value)), repack: async () => null, reaction: async () => {
				if (++count === 1) {
 throw new Error('REACTION_FAILED'); 
}
				return ':own:';
			} });
			for (const id of record.input.channels) {
				await stream.receive({ type: 'connect', body: { id, channel: 'homeTimeline' } });
			}
			await expect(stream.publish({ channel: 'notesStream', message: copy(record.input.payload) })).rejects.toThrow();
			expect(sent).toEqual(record.sent);
		} else if (record.kind === 'hiding') {
			const payload = copy(record.input.payload) as StreamNote;
			const f = facts(record.input.facts);
			if (record.input.facts.hidingFollowing) {
				f.following = new Map(Object.entries(record.input.facts.hidingFollowing));
			}
			expect(copy(hideStreamNote(payload, f, Date.parse('2026-11-07T00:00:00.000Z')))).toEqual(record.output);
			expect(payload).toEqual(record.input.payload);
		} else if (record.kind === 'noteUpdated') {
			const { stream, sent } = connection(facts(record.input.facts));
			await stream.receive({ type: 'subNote', body: { id: 'note' } });
			await stream.publish({ channel: 'noteStream:note', message: record.input.payload });
			expect(sent).toEqual(record.sent);
		} else if (record.kind === 'connect') {
			const { stream, sent } = connection(emptyStreamFacts(record.input.user?.id ?? null));
			await stream.receive({ type: 'connect', body: { id: 'channel-id', channel: record.input.channel, pong: record.input.pong } });
			expect(sent).toEqual(record.sent);
		}
	});
}
