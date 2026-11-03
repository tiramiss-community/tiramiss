/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createOutboundHttpClient } from '../../../src/composition/outbound-http.js';
import { installFakeDns, publicStandIn, startFakeServers } from '../../helpers/outbound-http-fakes.js';
import type { ClientSettings, FakeServers, HttpCase, ProbeClient } from '../../helpers/outbound-http-fakes.js';

const recorded = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/outbound-http/http-cases.json', import.meta.url), 'utf8')) as {
	inputs: { cases: HttpCase[] };
	cases: { id: string }[];
};
const expected = new Map(recorded.cases.map(c => [c.id, c]));

function client(settings: ClientSettings): ProbeClient {
	const { userAgent, ...outboundHttp } = settings;
	// 本番だけで行う private 判定を、テストでは composition の引数で有効にする。
	return createOutboundHttpClient({ userAgent, outboundHttp }, { checkPrivateAddress: true });
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

test('every recorded upstream observation has an input case', () => {
	expect(recorded.cases.map(c => c.id)).toEqual(recorded.inputs.cases.map(c => c.id));
});

test.for(recorded.inputs.cases)('$id behaves like the pinned upstream', async (c, context) => {
	if (!servers.tls && c.url.includes('{tls')) {
		// 証明書を作れない環境では https の case を実行できない。CI と probe は openssl を前提にする。
		context.skip();
	}

	expect(await servers.run(c, client)).toEqual(expected.get(c.id));
});

test('runs validators only for 2xx responses, before the body is read', async () => {
	const http = createOutboundHttpClient({ userAgent: 'Misskey/test (https://example.test)', outboundHttp: { allowedPrivateNetworks: publicStandIn } }, { checkPrivateAddress: true });
	const seen: number[] = [];
	const validators = [(response: { status: number }) => {
		seen.push(response.status);
		throw new Error('rejected by validator');
	}];

	await expect(http.send(servers.expand('{public}/echo'), {}, { validators })).rejects.toThrow('rejected by validator');
	const notFound = await http.send(servers.expand('{public}/status/404'), {}, { okOnly: false, validators });

	expect(notFound.status).toBe(404);
	expect(seen).toEqual([200]);
});
