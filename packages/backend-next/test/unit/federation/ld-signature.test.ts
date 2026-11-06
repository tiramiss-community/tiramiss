/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { signRsaSignature2017 } from '../../../src/platform/jsonld-signature.js';
import { loadBundledJsonLdContext } from '../../../src/platform/jsonld-contexts.js';
import { independentLdMaterial, ldVectors, verifyLdSignature } from '../../helpers/ld-signature.js';
import { loadApDeliverCases } from '../../helpers/ap-deliver-cases.js';
import type { RenderCases } from '../../helpers/ap-deliver-cases.js';

const keys = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/ap-request/test-only-keypair.json', import.meta.url), 'utf8'));
const { inputs, cases } = ldVectors;

test.for(inputs.activities.map((activity: Record<string, unknown>, index: number) => ({ activity, index })))('matches fixed upstream vector $index and independently verifies raw signed data', async ({ activity, index }) => {
	const original = structuredClone(activity);
	const signed = await signRsaSignature2017(activity, { privateKeyPem: keys.privateKeyPem, creator: inputs.creator }, new Date(inputs.created), inputs.nonce);
	expect(signed).toEqual(cases[index].signed);
	const { signed: _signed, verified, ...material } = cases[index];
	expect(verified).toBe(true);
	expect(await independentLdMaterial(signed)).toEqual(material);
	expect(await verifyLdSignature(signed, keys.publicKeyPem)).toBe(true);
	expect(activity).toEqual(original);
});

test.for(['content', 'creator', 'created', 'nonce', 'signatureValue'])('independent verification rejects changed $0', async field => {
	const signed = structuredClone(cases[0].signed);
	if (field === 'content') {
		(signed.object as Record<string, unknown>).content = 'tampered';
	} else {
		const signature = signed.signature as Record<string, string>;
		signature[field] = field === 'signatureValue' ? 'AAAA' : `${signature[field]}changed`;
	}
	expect(await verifyLdSignature(signed, keys.publicKeyPem)).toBe(false);
});

test('independent verification rejects a different RSA public key', async () => {
	const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
	expect(await verifyLdSignature(cases[0].signed, wrong)).toBe(false);
});

test('bundled documents equal upstream captured contexts and unknown URLs cannot fetch', async () => {
	for (const [url, document] of Object.entries(inputs.contexts)) {
		expect((await loadBundledJsonLdContext(url)).document).toEqual(document);
	}
	await expect(loadBundledJsonLdContext('https://unknown.test/context')).rejects.toThrow();
	await expect(signRsaSignature2017({ '@context': 'https://unknown.test/context', type: 'Create' }, { privateKeyPem: keys.privateKeyPem, creator: inputs.creator }, new Date(inputs.created), inputs.nonce)).rejects.toThrow();
});

const relayActivities = loadApDeliverCases<RenderCases>('render-cases.json').cases.filter(c => c.relay);
test('all 43 relay-marked rendered activities sign and verify with bundled contexts alone', async () => {
	expect(relayActivities).toHaveLength(43);
	for (const c of relayActivities) {
		const signed = await signRsaSignature2017(JSON.parse(c.activity!), { privateKeyPem: keys.privateKeyPem, creator: inputs.creator }, new Date(inputs.created), inputs.nonce);
		expect(await verifyLdSignature(signed, keys.publicKeyPem), c.id).toBe(true);
	}
});
