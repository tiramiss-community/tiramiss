/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createDeliverToRelays } from '../../../src/modules/federation/relay-delivery.js';
import { loadApDeliverCases } from '../../helpers/ap-deliver-cases.js';
import type { DeliverOne } from '../../../src/modules/federation/deliver-job.js';

interface RelayObservation {
	activity: Record<string, unknown> | null;
	relays: { inbox: string }[];
	calls: unknown[][];
}

const recorded = loadApDeliverCases<{
	inputs: { author: { id: string; host: null } };
	cases: (RelayObservation | { mode: string })[];
}>('relay-cases.json');
const activityCases = recorded.cases.filter((c): c is RelayObservation => 'activity' in c);
const author = { id: 'alice' };
const relays = [{ inbox: 'https://same.test/inbox' }, { inbox: 'https://second.test/inbox' }];

function setup(options: { relays?: typeof relays; enqueue?: (input: DeliverOne) => Promise<void> } = {}) {
	const submitted: DeliverOne[] = [];
	const readAcceptedRelays = vi.fn(async () => options.relays ?? relays);
	const attachLdSignature = vi.fn(async (copy: Record<string, unknown>, user: { id: string }) => {
		(copy.object as Record<string, unknown>).content = 'changed';
		return { ...copy, signature: { creator: user.id } };
	});
	const run = createDeliverToRelays({ readAcceptedRelays, attachLdSignature, enqueue: options.enqueue ?? (async job => {
		submitted.push(job);
	}) });
	return { run, submitted, readAcceptedRelays, attachLdSignature };
}

test.for(activityCases.map((expected, index) => ({ expected, index })))('matches fixed upstream producer observation $index', async ({ expected }) => {
	const activity = structuredClone(expected.activity);
	const calls: unknown[][] = [];
	const submitted: DeliverOne[] = [];
	const run = createDeliverToRelays({
		readAcceptedRelays: async () => {
			calls.push(['lookup']);
			return expected.relays;
		},
		attachLdSignature: async (copy, user) => {
			calls.push(['sign', structuredClone(copy), user, copy !== activity]);
			if (copy.object) {
				(copy.object as Record<string, unknown>).content = 'changed';
			}
			return { ...copy, signature: 'signed' };
		},
		enqueue: async job => {
			submitted.push(job);
			calls.push(['deliver', job.user, job.activity, job.to, job.isSharedInbox]);
		},
	});
	await run(recorded.inputs.author, activity);
	// The reader port owns selection; its PostgreSQL test checks the recorded findBy query.
	expect(calls).toEqual(expected.calls.map(call => call[0] === 'findBy' ? ['lookup'] : call));
	expect(activity).toEqual(expected.activity);
	if (submitted.length > 1) {
		expect(submitted[0].activity).toBe(submitted[1].activity);
	}
});

test.for(['sync', 'async'])('a %s enqueue failure attempts later relays and waits for them', async mode => {
	const failure = new Error('queue unavailable');
	const calls: string[] = [];
	let release!: () => void;
	const slow = new Promise<void>(resolve => {
		release = resolve;
	});
	const s = setup({ enqueue: job => {
		calls.push(job.to!);
		if (job.to === relays[0].inbox) {
			if (mode === 'sync') {
				throw failure;
			}
			return Promise.reject(failure);
		}
		return slow;
	} });
	let finished = false;
	const outcome = s.run(author, { object: {} }).catch(error => {
		finished = true;
		return error;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(calls).toEqual(relays.map(r => r.inbox));
	expect(finished).toBe(false);
	release();
	expect(await outcome).toBe(failure);
});

test('multiple enqueue failures retain every error', async () => {
	const errors = [new Error('first'), new Error('second')];
	const s = setup({ enqueue: async job => {
		throw errors[relays.findIndex(r => r.inbox === job.to)];
	} });
	await expect(s.run(author, { object: {} })).rejects.toMatchObject({ errors });
});
