/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createNotifyPollEnded } from '../../../src/modules/notification/public.js';
import type { PostNotification } from '../../../src/modules/notification/public.js';

type Profile = { userHost: string | null; notificationRecieveConfig: Record<string, { type: string } | undefined> };
type ProcessorCase = {
	id: string;
	note: { userId: string; hasPoll: boolean } | null;
	votes: { userId: string; userHost: string | null }[];
	profiles: Record<string, Profile>;
	storeFailsFor?: string[];
};
type Recorded = {
	id: string;
	result: { returned: true } | { thrown: { name: string } };
	createNotificationCalls: [string, string, { noteId: string }][];
	stored: { recipientId: string; notification: Record<string, unknown> }[];
};

const recorded = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/poll-ended/processor-cases.json', import.meta.url), 'utf8')) as {
	inputs: { noteId: string; cases: ProcessorCase[] };
	cases: Recorded[];
};
const now = Date.UTC(2026, 10, 3);

function setup(noteId: string, c: ProcessorCase) {
	const saved: PostNotification[] = [];
	const attempted: string[] = [];
	let sequence = 0;
	const notify = createNotifyPollEnded({
		readNote: async id => c.note === null || id !== noteId ? null : { id, ...c.note },
		// 本家の SQL（user.host IS NULL の inner join）の結果。SQL 自体は結合テストで確かめる。
		readLocalVoterIds: async () => c.votes.filter(vote => vote.userHost === null).map(vote => vote.userId),
		readRecipient: async userId => {
			const profile = c.profiles[userId];
			if (profile === undefined) {
				throw new Error('profile not found');
			}
			return { userHost: profile.userHost, receiveConfig: profile.notificationRecieveConfig.pollEnded?.type ?? null };
		},
		notifications: {
			run: work => work({
				save: async notification => {
					attempted.push(notification.recipientId);
					if (c.storeFailsFor?.includes(notification.recipientId)) {
						throw new Error('store failed');
					}
					saved.push(notification);
				},
			}),
		},
		newId: at => `${at}-${sequence++}`,
		currentTime: () => now,
	});
	return { notify, saved, attempted };
}

test.each(recorded.inputs.cases.map((c, index) => [c.id, c, recorded.cases[index]] as const))('matches pinned upstream processor: %s', async (_id, c, expected) => {
	const { notify, saved, attempted } = setup(recorded.inputs.noteId, c);
	const run = notify.notifyPollEnded({ noteId: recorded.inputs.noteId });

	if ('thrown' in expected.result) {
		await expect(run).rejects.toThrow();
	} else {
		const result = await run;
		expect(result.notifiedUserIds).toEqual(expected.stored.map(entry => entry.recipientId));
		expect(result.failures.map(failure => failure.recipientId)).toEqual(c.storeFailsFor ?? []);
	}

	// 本家が通知を保存した受信者と順序が一致し、保存の失敗は他の受信者を止めない。
	expect(saved.map(notification => notification.recipientId)).toEqual(expected.stored.map(entry => entry.recipientId));
	expect(attempted.filter(id => !saved.some(notification => notification.recipientId === id))).toEqual(c.storeFailsFor ?? []);
	for (const [index, entry] of expected.stored.entries()) {
		// 本家の通知は notifierId を持たず、noteId だけを持つ。
		expect(entry.notification).toEqual({ id: '{id}', createdAt: '{createdAt}', type: 'pollEnded', noteId: recorded.inputs.noteId });
		expect(saved[index]).toEqual({
			id: expect.stringMatching(new RegExp(`^${now}-`)), recipientId: entry.recipientId, type: 'pollEnded', notifierId: null,
			noteId: recorded.inputs.noteId, targetNoteId: null, createdAtMs: now,
		});
	}
	expect(new Set(saved.map(notification => notification.id)).size).toBe(saved.length);
});

test('every recorded upstream case is connected', () => {
	expect(recorded.cases.map(c => c.id)).toEqual(recorded.inputs.cases.map(c => c.id));
	expect(recorded.cases.length).toBeGreaterThan(0);
});
