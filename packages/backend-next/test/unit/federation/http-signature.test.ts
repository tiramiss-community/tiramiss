/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createSignedGet, createSignedPost } from '../../../src/modules/federation/public.js';

type SigningInput =
	| { id: string; method: 'POST'; url: string; body: string; digest?: string; additionalHeaders: Record<string, string> }
	| { id: string; method: 'GET'; url: string; additionalHeaders: Record<string, string> };
type SigningCase =
	| { id: string; expected: { request: { url: string; method: string; headers: Record<string, string> }; signingString: string; signature: string; signatureHeader: string } }
	| { id: string; error: { name: string; message: string; code: string } };

const compatibility = new URL('../../../../../docs/superpowers/compatibility/ap-request/', import.meta.url);
const keypair = JSON.parse(readFileSync(new URL('test-only-keypair.json', compatibility), 'utf8')) as { publicKeyPem: string; privateKeyPem: string };
const recorded = JSON.parse(readFileSync(new URL('signing-cases.json', compatibility), 'utf8')) as {
	inputs: { now: string; keyId: string; cases: SigningInput[] };
	cases: SigningCase[];
};
const expected = new Map(recorded.cases.map(c => [c.id, c]));
const key = { privateKeyPem: keypair.privateKeyPem, keyId: recorded.inputs.keyId };
const now = new Date(recorded.inputs.now);

function signCase(c: SigningInput) {
	return c.method === 'POST'
		? createSignedPost({ key, url: c.url, body: c.body, digest: c.digest, additionalHeaders: c.additionalHeaders }, now)
		: createSignedGet({ key, url: c.url, additionalHeaders: c.additionalHeaders }, now);
}

test('every recorded upstream signature has an input case', () => {
	expect(recorded.cases.map(c => c.id)).toEqual(recorded.inputs.cases.map(c => c.id));
});

test.for(recorded.inputs.cases)('$id signs byte-for-byte like the pinned upstream', async c => {
	const upstream = expected.get(c.id);
	if (upstream === undefined) {
		throw new Error(`no recorded case for ${c.id}`);
	}

	if ('error' in upstream) {
		await expect(signCase(c)).rejects.toMatchObject(upstream.error);
		return;
	}
	const signed = await signCase(c);
	expect(signed).toEqual(upstream.expected);
	expect(verify('sha256', Buffer.from(signed.signingString), keypair.publicKeyPem, Buffer.from(signed.signature, 'base64'))).toBe(true);
});
