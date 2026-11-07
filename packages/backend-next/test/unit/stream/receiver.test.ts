/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test } from 'vitest';
import { createStreamConnection, emptyStreamFacts, filterHomeNote, hideStreamNote, noteVisible, type StreamNote } from '../../../src/modules/stream/public.js';

const note = (overrides: Partial<StreamNote> = {}): StreamNote => ({ id: 'n', createdAt: '2026-11-07T00:00:00Z', userId: 'a', user: { id: 'a', host: null }, text: 'snapshot', cw: null, visibility: 'public', fileIds: [], files: [], reactions: {}, ...overrides });
const facts = () => ({ ...emptyStreamFacts('me'), following: new Map([['a', { withReplies: false }]]) });

describe('receiver policy', () => {
	test('home accepts followed snapshot while preserving reply and renote rules', () => {
		const f = facts();
		expect(filterHomeNote(note(), f, {})).toBe(true);
		expect(filterHomeNote(note({ userId: 'stranger' }), f, {})).toBe(false);
		expect(filterHomeNote(note({ reply: note({ userId: 'other' }) }), f, {})).toBe(false);
		f.following.set('a', { withReplies: true });
		expect(filterHomeNote(note({ reply: note({ userId: 'other' }) }), f, {})).toBe(true);
		expect(filterHomeNote(note({ reply: note({ userId: 'other', visibility: 'followers' }) }), f, {})).toBe(false);
		expect(filterHomeNote(note({ text: null, renoteId: 'r', renote: note() }), f, { withRenotes: false })).toBe(false);
		expect(filterHomeNote(note({ text: null, renoteId: 'r', renote: note(), poll: { choices: [] } }), f, { withRenotes: false })).toBe(true);
		expect(filterHomeNote(note({ text: null, renoteId: 'r', renote: note(), replyId: 'q' }), f, { withRenotes: false })).toBe(true);
		expect(filterHomeNote(note(), f, { withFiles: true })).toBe(false);
		expect(filterHomeNote(note({ fileIds: ['f'] }), f, { withFiles: true })).toBe(true);
	});
	test('visibility exceptions and immediate related mute/block/channel differ from deep hiding', () => {
		const f = facts();
		expect(noteVisible(note({ visibility: 'followers', userId: 'other', mentions: ['me'] }), f)).toBe(true);
		expect(noteVisible(note({ visibility: 'specified', visibleUserIds: [] }), f)).toBe(false);
		for (const key of ['mutedUsers', 'blockingUsers'] as const) {
			f[key].add('r');
			expect(filterHomeNote(note({ renote: note({ userId: 'r' }) }), f, {})).toBe(false);
			f[key].clear();
		}
		f.mutedInstances.add('muted.test');
		expect(filterHomeNote(note({ reply: note({ user: { id: 'r', host: 'muted.test' } }) }), f, {})).toBe(false);
		f.mutedChannels.add('c');
		expect(filterHomeNote(note({ renote: note({ channelId: 'c' }) }), f, {})).toBe(false);
		f.followingChannels.add('c');
		expect(filterHomeNote(note({ channelId: 'c' }), f, {})).toBe(false);
	});
	test('nested hiding clones snapshots and drops hidden pure renotes', () => {
		const f = facts();
		const input = note({ renote: note({ id: 'r', userId: 'other', visibility: 'specified', visibleUserIds: ['other'], reply: note({ user: { id: 'a', makeNotesHiddenBefore: 9999999999 } }) }) });
		const out = hideStreamNote(input, f, 1794000000000)!;
		expect(out.renote).toMatchObject({ text: null, isHidden: true, fileIds: [] });
		expect(out.renote!.reply).toMatchObject({ isHidden: true });
		expect(input.renote!.text).toBe('snapshot');
		expect(hideStreamNote(note({ text: null, renoteId: 'r', renote: input.renote }), f, 1794000000000)).toBeNull();
		expect(hideStreamNote(input, { ...f, userId: 'other' }, 1794000000000)!.renote!.text).toBe('snapshot');
	});
});

function connection(userId: string | null = 'me') {
	const sent: unknown[] = [];
	const f = { ...facts(), userId };
	const stream = createStreamConnection({ facts: () => f, now: () => 1794000000000, send: value => sent.push(value), repack: async () => ({ ...note(), text: 'private rendered' }), reaction: async () => '❤' });
	return { stream, sent, f };
}

test('main filters only notification and mention and repacks hidden notes per receiver', async () => {
	const { stream, sent, f } = connection();
	await stream.receive({ type: 'connect', body: { id: 'm', channel: 'main', pong: true } });
	f.mutedUsers.add('a');
	for (const type of ['notification', 'mention', 'reply', 'renote']) {
		await stream.publish({ channel: 'mainStream:me', message: { type, body: type === 'notification' ? { userId: 'a', user: { host: null } } : note() } });
	}
	expect(sent).toEqual([{ type: 'connected', body: { id: 'm' } }, ...['reply', 'renote'].map(type => ({ type: 'channel', body: { id: 'm', type, body: note() } }))]);
	await stream.publish({ channel: 'mainStream:someone', message: { type: 'reply', body: note() } });
	expect(sent).toHaveLength(3);
	f.mutedUsers.clear();
	await stream.publish({ channel: 'mainStream:me', message: { type: 'notification', body: { note: note({ isHidden: true }) } } });
	expect(sent.at(-1)).toMatchObject({ body: { type: 'notification', body: { note: { text: 'private rendered' } } } });
});

test('note aliases reference count and remove authorization metadata from deletion envelopes', async () => {
	const { stream, sent, f } = connection();
	const event = { channel: 'noteStream:n', message: { type: 'deleted', body: { id: 'n', userId: 'other', visibility: 'followers', visibleUserIds: [], body: { deletedAt: 'now' } } } };
	await stream.receive({ type: 's', body: { id: 'n' } });
	await stream.receive({ type: 'sr', body: { id: 'n' } });
	await stream.receive({ type: 'un', body: { id: 'n' } });
	await stream.publish(event);
	expect(sent).toEqual([]);
	f.following.set('other', { withReplies: false });
	await stream.publish(event);
	expect(sent).toEqual([{ type: 'noteUpdated', body: { id: 'n', type: 'deleted', body: { deletedAt: 'now' } } }]);
	await stream.receive({ type: 'unsubNote', body: { id: 'n' } });
	await stream.publish(event);
	expect(sent).toHaveLength(1);
});

test('1536-note LRU refreshes access and evicts the oldest subscription', async () => {
	const { stream, sent } = connection();
	for (let i = 0; i < 1536; i++) {
		await stream.receive({ type: 'subNote', body: { id: String(i) } });
	}
	await stream.receive({ type: 's', body: { id: '0' } });
	await stream.receive({ type: 's', body: { id: 'new' } });
	for (const id of ['0', '1', 'new']) {
		await stream.publish({ channel: `noteStream:${id}`, message: { type: 'deleted', body: { id, userId: 'a', visibility: 'public', body: {} } } });
	}
	expect(sent).toMatchObject([{ body: { id: '0' } }, { body: { id: 'new' } }]);
});

test('channel validation, limit, shared main and id replacement use optional acknowledgement', async () => {
	const { stream, sent } = connection();
	for (const body of [null, {}, { id: 'x', channel: 'main', params: null }, { id: 'x', channel: 'main', pong: 1 }, { id: 'x', channel: 'unsupported', pong: true }]) {
		await stream.receive({ type: 'connect', body });
	}
	await stream.receive({ type: 'connect', body: { id: 'm', channel: 'main' } });
	await stream.receive({ type: 'connect', body: { id: 'm2', channel: 'main', pong: true } });
	for (let i = 0; i < 31; i++) {
		await stream.receive({ type: 'connect', body: { id: String(i), channel: 'homeTimeline' } });
	}
	await stream.receive({ type: 'connect', body: { id: 'overflow', channel: 'homeTimeline', pong: true } });
	await stream.receive({ type: 'connect', body: { id: '0', channel: 'homeTimeline', pong: true } });
	expect(sent).toEqual([{ type: 'connected', body: { id: '0' } }]);
	const guest = connection(null);
	await guest.stream.receive({ type: 'connect', body: { id: 'x', channel: 'homeTimeline', pong: true } });
	await guest.stream.receive({ type: 's', body: { id: 'n' } });
	guest.f.ugcVisibilityForVisitor = 'none';
	await guest.stream.publish({ channel: 'noteStream:n', message: { type: 'deleted', body: { id: 'n', visibility: 'public' } } });
	expect(guest.sent).toEqual([]);
});

test('routing snapshots do not expose follower content after the separate hiding relationship changes', async () => {
	const sent: any[] = [];
	const stream = createStreamConnection({ facts: facts, now: () => 1794000000000, send: value => sent.push(value), repack: async () => null, reaction: async () => undefined, hidingFollowing: async () => new Set() });
	await stream.receive({ type: 'connect', body: { id: 'h', channel: 'homeTimeline' } });
	await stream.publish({ channel: 'notesStream', message: note({ visibility: 'followers' }) });
	expect(sent[0].body.body).toMatchObject({ text: null, isHidden: true });
});

test('a failed reaction read for one home listener does not suppress a sibling listener', async () => {
	const sent: any[] = [];
	let calls = 0;
	const stream = createStreamConnection({ facts, now: () => 1794000000000, send: value => sent.push(value), repack: async () => null, reaction: async () => {
 if (++calls === 1) {
 throw new Error('REACTION_FAILED'); 
} return '❤'; 
} });
	for (const id of ['first', 'second']) {
		await stream.receive({ type: 'connect', body: { id, channel: 'homeTimeline' } });
	}
	await expect(stream.publish({ channel: 'notesStream', message: note({ text: null, renoteId: 'r', renote: note({ reactions: { '❤': 1 } }) }) })).rejects.toThrow();
	expect(sent).toMatchObject([{ body: { id: 'second', body: { renote: { myReaction: '❤' } } } }]);
});
