/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jsonld from 'jsonld';
import type { JsonLdDocument } from 'jsonld';
import type { JsonLd } from 'jsonld/jsonld-spec.js';

export interface LdVectors {
	inputs: { contexts: Record<string, JsonLd>; creator: string; created: string; nonce: string; activities: Record<string, unknown>[] };
	cases: { canonicalOptions: string; canonicalDocument: string; optionsHash: string; documentHash: string; verificationData: string; signed: Record<string, unknown>; verified: boolean }[];
}

export const ldVectors: LdVectors = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/ap-deliver/ld-signature-cases.json', import.meta.url), 'utf8'));

/** Fixture-only canonicalization oracle, independent of the production signer and loader. */
export async function independentLdMaterial(activity: Record<string, unknown>) {
	const options: Record<string, unknown> = { ...(activity.signature as Record<string, unknown>), '@context': 'https://w3id.org/identity/v1' };
	for (const key of ['type', 'id', 'signatureValue']) {
		delete options[key];
	}
	const document = { ...activity };
	delete document.signature;
	const canonical = [];
	for (const value of [options, document]) {
		canonical.push(await jsonld.normalize(value as JsonLdDocument, { documentLoader: async url => {
			if (!Object.hasOwn(ldVectors.inputs.contexts, url)) {
				throw new Error('test refuses remote contexts');
			}
			return { documentUrl: url, contextUrl: undefined, document: ldVectors.inputs.contexts[url] };
		} }));
	}
	const [optionsHash, documentHash] = canonical.map(value => createHash('sha256').update(value).digest('hex'));
	return { canonicalOptions: canonical[0], canonicalDocument: canonical[1], optionsHash, documentHash, verificationData: optionsHash + documentHash };
}

export async function verifyLdSignature(activity: Record<string, unknown>, publicKeyPem: string): Promise<boolean> {
	try {
		const signature = activity.signature as Record<string, string>;
		if (signature.type !== 'RsaSignature2017') {
			return false;
		}
		const { verificationData } = await independentLdMaterial(activity);
		return verify('RSA-SHA256', Buffer.from(verificationData, 'utf8'), publicKeyPem, Buffer.from(signature.signatureValue, 'base64'));
	} catch {
		return false;
	}
}
