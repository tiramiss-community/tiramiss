/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createDeliverCreatedNote, createDigest, NoteDeliveryError } from '../../../src/modules/federation/public.js';
import { deliverJobs } from '../../../src/platform/job-queue/deliver.js';
import { deliveryFactsFor, loadApDeliverCases, renderMaterialsFor, withMentionTagsAsSet } from '../../helpers/ap-deliver-cases.js';
import type { DeliverBatch } from '../../../src/modules/federation/public.js';
import type { RenderCases } from '../../helpers/ap-deliver-cases.js';

const recorded = loadApDeliverCases<RenderCases>('render-cases.json');
const { inputs } = recorded;
const expected = new Map(recorded.cases.map(c => [c.id, c]));

type RenderCase = RenderCases['inputs']['cases'][number];

// 本家の probe と同じく、following の行の inbox は利用者の inbox と同じにする。
function deliver(c: RenderCase) {
	const batches: DeliverBatch[] = [];
	const followeeIds: string[] = [];
	const run = createDeliverCreatedNote({
		readNote: async noteId => (noteId === c.note.id ? { ...renderMaterialsFor(inputs, c), delivery: deliveryFactsFor(inputs, c) } : null),
		readUsers: async ids => inputs.users.filter(user => ids.includes(user.id)),
		readFollowerInboxes: async followeeId => {
			followeeIds.push(followeeId);
			return c.followers.map(id => inputs.users.find(user => user.id === id)!).map(user => ({ followerSharedInbox: user.sharedInbox, followerInbox: user.inbox }));
		},
		enqueue: async batch => {
			batches.push(batch);
		},
		selfUrl: inputs.selfUrl,
		currentTime: () => Date.parse(inputs.now),
	});
	return { run: () => run(c.note.id), batches, followeeIds };
}

test.for(inputs.cases)('$id enqueues the same deliveries as the pinned upstream (relay excluded)', async c => {
	const upstream = expected.get(c.id)!;
	const { run, batches, followeeIds } = deliver(c);

	if (upstream.addBulk === null) {
		// 本家が投入しなかった投稿。表現か宛先の選定で失敗したものだけが例外になる。
		if (upstream.unhandledRejections.length === 0) {
			await run();
		} else {
			await expect(run()).rejects.toBeInstanceOf(NoteDeliveryError);
		}
		expect(batches).toEqual([]);
		return;
	}

	await run();
	expect(batches).toHaveLength(1);
	const [batch] = batches;
	const jobs = deliverJobs(batch, {});
	expect(jobs.map(job => ({ name: job.name, to: job.data.to, isSharedInbox: job.data.isSharedInbox }))).toEqual(upstream.addBulk.jobs);
	expect(withMentionTagsAsSet(jobs[0]?.data.content ?? JSON.stringify(batch.activity))).toBe(withMentionTagsAsSet(upstream.activity!));
	// メンションの順が本家の問い合わせの順と違う case だけは本文が変わり、digest も変わる。
	if (jobs.length > 0 && JSON.stringify(batch.activity) === upstream.activity) {
		expect(createDigest(JSON.stringify(batch.activity))).toBe(upstream.addBulk.digest);
	}
	expect(followeeIds.length).toBe(upstream.followingsQueries.length);
});

test.for([
	['public-follower-without-inbox', 'FOLLOWER_INBOX_MISSING'],
	['renote-specified', 'RENDER_FAILED'],
	['mfm-ruby-crash', 'RENDER_FAILED'],
] as const)('%s fails with %s so that the post-save log can tell why nothing was delivered', async ([id, code]) => {
	const { run } = deliver(inputs.cases.find(c => c.id === id)!);

	await expect(run()).rejects.toMatchObject({ name: 'NoteDeliveryError', code });
});

test('a note deleted before the post-save work is not delivered', async () => {
	const c = inputs.cases.find(x => x.id === 'public-plain')!;
	const batches: DeliverBatch[] = [];
	const run = createDeliverCreatedNote({
		readNote: async () => null,
		readUsers: async () => [],
		readFollowerInboxes: async () => [],
		enqueue: async batch => {
			batches.push(batch);
		},
		selfUrl: inputs.selfUrl,
		currentTime: () => Date.parse(inputs.now),
	});

	await run(c.note.id);

	expect(batches).toEqual([]);
});

test('reply and renote authors are looked up only when the saved host is remote', async () => {
	const c = inputs.cases.find(x => x.id === 'quote-reply-only')!;
	const looked: string[][] = [];
	const run = createDeliverCreatedNote({
		readNote: async () => ({ ...renderMaterialsFor(inputs, c), delivery: { ...deliveryFactsFor(inputs, c), mentions: [] } }),
		readUsers: async ids => {
			looked.push([...ids]);
			return inputs.users.filter(user => ids.includes(user.id));
		},
		readFollowerInboxes: async () => [],
		enqueue: async () => {},
		selfUrl: inputs.selfUrl,
		currentTime: () => Date.parse(inputs.now),
	});

	await run(c.note.id);

	// 返信先はローカルの投稿、Renote 先はリモートの投稿。
	expect(looked).toEqual([[deliveryFactsFor(inputs, c).renoteUserId]]);
});
