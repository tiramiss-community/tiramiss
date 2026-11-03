/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createOutboundHttpClient } from '../../../src/composition/outbound-http.js';
import { classifyDeliveryFailure, createSignedPostSender, deliverySucceeded } from '../../../src/modules/federation/public.js';
import { expectUpstreamDelivery } from '../../helpers/ap-delivery.js';
import { installFakeDns, startFakeServers } from '../../helpers/outbound-http-fakes.js';
import type { UpstreamDelivery } from '../../helpers/ap-delivery.js';
import type { ClientSettings, FakeServers, InboxCase, InboxObservation } from '../../helpers/outbound-http-fakes.js';

const compatibility = new URL('../../../../../docs/superpowers/compatibility/ap-request/', import.meta.url);
const keypair = JSON.parse(readFileSync(new URL('test-only-keypair.json', compatibility), 'utf8')) as { publicKeyPem: string; privateKeyPem: string };
const recorded = JSON.parse(readFileSync(new URL('inbox-cases.json', compatibility), 'utf8')) as {
	inputs: { selfUrl: string; userId: string; now: string; cases: InboxCase[] };
	cases: (InboxObservation & { delivery: { personalInbox: UpstreamDelivery; sharedInbox: UpstreamDelivery } })[];
};
const expected = new Map(recorded.cases.map(c => [c.id, c]));

function post(settings: ClientSettings, url: string, object: unknown, digest: string | undefined) {
	const { userAgent, ...outboundHttp } = settings;
	// 本番だけで行う private 判定を、テストでは composition の引数で有効にする。
	const http = createOutboundHttpClient({ userAgent, outboundHttp }, { checkPrivateAddress: true });
	const signedPost = createSignedPostSender({
		readUserKeypair: async () => keypair,
		send: http.send,
		selfUrl: recorded.inputs.selfUrl,
		clock: () => Date.parse(recorded.inputs.now),
	});
	return signedPost({ id: recorded.inputs.userId }, url, object, digest);
}

let servers: FakeServers;
let restoreDns: () => void;

beforeAll(async () => {
	restoreDns = installFakeDns();
	servers = await startFakeServers();
});

afterAll(async () => {
	await servers?.close();
	restoreDns?.();
});

test('every recorded upstream delivery has an input case', () => {
	expect(recorded.cases.map(c => c.id)).toEqual(recorded.inputs.cases.map(c => c.id));
});

// 偽の inbox は、受け取った method・path・ヘッダー・本文だけで署名（test-only-keypair.json の公開鍵による crypto.verify）と Digest を検証し、verified に残す。
test.for(recorded.inputs.cases)('$id reaches the inbox and is classified like the pinned upstream', { timeout: 30000 }, async c => {
	const upstream = expected.get(c.id);
	if (upstream === undefined) {
		throw new Error(`no recorded case for ${c.id}`);
	}
	const { delivery, ...observed } = upstream;

	const { observation, failure } = await servers.runInbox(c, post, keypair.publicKeyPem);
	expect(observation).toEqual(observed);

	const to = servers.expand(c.url);
	const outcomeFor = (isSharedInbox: boolean) => (failure === null ? deliverySucceeded : classifyDeliveryFailure({ to, isSharedInbox }, failure.error));
	expectUpstreamDelivery(outcomeFor(false), failure?.error, delivery.personalInbox, servers.normalize);
	expectUpstreamDelivery(outcomeFor(true), failure?.error, delivery.sharedInbox, servers.normalize);
});

test('a direct 2xx delivery carries a signature and digest the inbox can verify', async () => {
	const accepted = recorded.inputs.cases.find(c => c.id === 'accepted-object');
	if (accepted === undefined) {
		throw new Error('fixture has no accepted-object case');
	}

	const { observation, failure } = await servers.runInbox(accepted, post, keypair.publicKeyPem);

	expect(failure).toBeNull();
	expect(observation.received.map(request => request.verified)).toEqual([{ signature: true, digest: true }]);
});
