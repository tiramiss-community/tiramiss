/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { DeliverOne } from './deliver-job.js';

export type AttachLdSignature = (activity: Record<string, unknown>, author: { id: string }) => Promise<Record<string, unknown>>;

export function createDeliverToRelays(ports: {
	readAcceptedRelays(): Promise<readonly { inbox: string }[]>;
	attachLdSignature: AttachLdSignature;
	enqueue(input: DeliverOne): Promise<void>;
}) {
	return async (author: { id: string }, activity: Record<string, unknown> | null): Promise<void> => {
		if (activity === null) {
			return;
		}
		const relays = await ports.readAcceptedRelays();
		if (relays.length === 0) {
			return;
		}
		const copy = structuredClone(activity);
		if (!copy.to) {
			copy.to = ['https://www.w3.org/ns/activitystreams#Public'];
		}
		const signed = await ports.attachLdSignature(copy, author);
		// Observe every submission without letting a synchronous throw suppress later relays.
		const results = await Promise.allSettled(relays.map(async relay => ports.enqueue({ user: author, activity: signed, to: relay.inbox, isSharedInbox: false })));
		const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
		if (failures.length === 1) {
			throw failures[0];
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, 'relay submissions failed');
		}
	};
}
