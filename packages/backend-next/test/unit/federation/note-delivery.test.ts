/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
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
	const relayed: { author: { id: string }; activity: Record<string, unknown> }[] = [];
	const run = createDeliverCreatedNote({
		readNote: async noteId => (noteId === c.note.id ? { ...renderMaterialsFor(inputs, c), delivery: deliveryFactsFor(inputs, c) } : null),
		readUsers: async ids => inputs.users.filter(user => ids.includes(user.id)),
		readFollowerInboxes: async followeeId => {
			followeeIds.push(followeeId);
			return c.followers.map(id => inputs.users.find(user => user.id === id)!).map(user => ({ followerSharedInbox: user.sharedInbox, followerInbox: user.inbox }));
		},
		deliverToRelays: async (author, activity) => {
			relayed.push({ author, activity });
		},
		enqueue: async batch => {
			batches.push(batch);
		},
		selfUrl: inputs.selfUrl,
		currentTime: () => Date.parse(inputs.now),
	});
	return { run: () => run(c.note.id), batches, followeeIds, relayed };
}

test.for(inputs.cases)('$id enqueues the same deliveries as the pinned upstream (including relay gate)', async c => {
	const upstream = expected.get(c.id)!;
	const { run, batches, followeeIds, relayed } = deliver(c);

	if (upstream.addBulk === null) {
		// 本家が投入しなかった投稿。表現か宛先の選定で失敗したものだけが例外になる。
		if (upstream.unhandledRejections.length === 0) {
			await run();
		} else {
			await expect(run()).rejects.toBeInstanceOf(NoteDeliveryError);
		}
		expect(relayed).toHaveLength(upstream.relay ? 1 : 0);
		expect(batches).toEqual([]);
		return;
	}

	await run();
	expect(relayed).toHaveLength(upstream.relay ? 1 : 0);
	if (upstream.relay) {
		expect(relayed[0].author).toEqual({ id: c.note.userId });
		expect(withMentionTagsAsSet(JSON.stringify(relayed[0].activity))).toBe(withMentionTagsAsSet(upstream.activity!));
	}
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
		deliverToRelays: async () => {},
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
		deliverToRelays: async () => {},
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

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

test.for(['success', 'relay', 'followers', 'enqueue', 'both'])('relay starts before followers; branches remain independent and drain all outcomes: %s', async mode => {
	const c = inputs.cases.find(x => x.id === 'public-plain')!;
	const relay = deferred();
	const ordinary = deferred();
	const events: string[] = [];
	const errors = { relay: new Error('signing failed'), followers: new NoteDeliveryError('FOLLOWER_INBOX_MISSING', 'missing'), enqueue: new Error('ordinary enqueue failed') };
	const run = createDeliverCreatedNote({
		readNote: async () => ({ ...renderMaterialsFor(inputs, c), delivery: deliveryFactsFor(inputs, c) }),
		readUsers: async () => [],
		deliverToRelays: async () => {
			events.push('relay');
			await relay.promise;
			events.push('relay-enqueue');
		},
		readFollowerInboxes: async () => {
			events.push('followers');
			await ordinary.promise;
			return [];
		},
		enqueue: async () => {
			events.push('ordinary-enqueue');
			if (mode === 'enqueue') {
				throw errors.enqueue;
			}
		},
		selfUrl: inputs.selfUrl, currentTime: () => Date.parse(inputs.now),
	});
	let done = false;
	const result = run(c.note.id).then(() => {
		done = true;
		return null;
	}, error => {
		done = true;
		return error;
	});
	await vi.waitFor(() => expect(events).toEqual(['relay', 'followers']));
	if (mode === 'followers' || mode === 'both') {
		ordinary.reject(errors.followers);
	} else {
		ordinary.resolve();
	}
	await new Promise(resolve => setImmediate(resolve));
	expect(done).toBe(false);
	if (mode === 'success' || mode === 'relay') {
		expect(events).toContain('ordinary-enqueue');
	}
	if (mode === 'relay' || mode === 'both') {
		relay.reject(errors.relay);
	} else {
		relay.resolve();
	}
	const error = await result;
	if (mode === 'both') {
		expect(error).toMatchObject({ errors: [errors.relay, errors.followers] });
	} else if (mode === 'success') {
		expect(error).toBe(null);
	} else {
		expect(error).toBe(errors[mode as 'relay' | 'followers' | 'enqueue']);
	}
});

test('direct-author lookup failure starts neither relay nor followers', async () => {
	const c = inputs.cases.find(x => x.id === 'quote-reply-only')!;
	const events: string[] = [];
	const failure = new Error('DB read failed');
	const run = createDeliverCreatedNote({
		readNote: async () => ({ ...renderMaterialsFor(inputs, c), delivery: deliveryFactsFor(inputs, c) }),
		readUsers: async () => {
			throw failure;
		},
		deliverToRelays: async () => {
			events.push('relay');
		},
		readFollowerInboxes: async () => {
			events.push('followers');
			return [];
		},
		enqueue: async () => {
			events.push('ordinary');
		},
		selfUrl: inputs.selfUrl, currentTime: () => Date.parse(inputs.now),
	});
	await expect(run(c.note.id)).rejects.toBe(failure);
	expect(events).toEqual([]);
});

test('a slow followers query does not delay relay submission, and completion still waits for followers', async () => {
	const c = inputs.cases.find(x => x.id === 'public-plain')!;
	const followers = deferred();
	const events: string[] = [];
	const run = createDeliverCreatedNote({
		readNote: async () => ({ ...renderMaterialsFor(inputs, c), delivery: deliveryFactsFor(inputs, c) }),
		readUsers: async () => [],
		deliverToRelays: async () => {
			events.push('relay-submitted');
		},
		readFollowerInboxes: async () => {
			await followers.promise;
			return [];
		},
		enqueue: async () => {
			events.push('ordinary-submitted');
		},
		selfUrl: inputs.selfUrl, currentTime: () => Date.parse(inputs.now),
	});
	let done = false;
	const result = run(c.note.id).then(() => {
		done = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(events).toEqual(['relay-submitted']);
	expect(done).toBe(false);
	followers.resolve();
	await result;
	expect(events).toEqual(['relay-submitted', 'ordinary-submitted']);
});
