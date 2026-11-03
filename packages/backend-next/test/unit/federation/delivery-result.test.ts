/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { OutboundStatusError } from '../../../src/application/outbound-http.js';
import { classifyDeliveryFailure, deliverySucceeded } from '../../../src/modules/federation/public.js';
import { expectUpstreamDelivery } from '../../helpers/ap-delivery.js';
import type { UpstreamDelivery } from '../../helpers/ap-delivery.js';

type Failure =
	| { id: string; kind: 'none' }
	| { id: string; kind: 'status'; statusCode: number; statusMessage?: string }
	| { id: string; kind: 'error'; name: string; message: string; props?: Record<string, unknown> };

const recorded = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/ap-request/delivery-cases.json', import.meta.url), 'utf8')) as {
	inputs: { inboxes: { to: string; isSharedInbox: boolean }[]; failures: Failure[] };
	cases: { to: string; isSharedInbox: boolean; failure: Failure; expected: UpstreamDelivery }[];
};

// 本家の probe と同じ組み立てで、signedPost が投げる例外を作る。
function errorOf(failure: Failure): unknown {
	switch (failure.kind) {
		case 'none':
			return undefined;
		case 'status':
			return new OutboundStatusError(`${failure.statusCode} ${failure.statusMessage}`, failure.statusCode, failure.statusMessage);
		case 'error':
			return Object.assign(new Error(failure.message), { name: failure.name }, failure.props);
	}
}

test('every recorded inbox and failure combination is compared', () => {
	expect(recorded.cases.length).toBe(recorded.inputs.inboxes.length * recorded.inputs.failures.length);
});

test.for(recorded.cases.map(c => ({ ...c, name: `${c.isSharedInbox ? 'shared' : 'personal'} ${c.to} ${c.failure.id}` })))(
	'$name is classified like the pinned upstream',
	c => {
		const error = errorOf(c.failure);
		const target = { to: c.to, isSharedInbox: c.isSharedInbox };
		expectUpstreamDelivery(c.failure.kind === 'none' ? deliverySucceeded : classifyDeliveryFailure(target, error), error, c.expected);
	},
);
