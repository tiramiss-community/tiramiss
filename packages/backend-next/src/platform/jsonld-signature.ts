/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash, sign } from 'node:crypto';
import jsonld from 'jsonld';
import { loadBundledJsonLdContext } from './jsonld-contexts.js';
import type { JsonLdDocument } from 'jsonld';

export async function signRsaSignature2017(
	activity: Record<string, unknown>,
	key: { privateKeyPem: string; creator: string },
	created: Date,
	nonce: string,
): Promise<Record<string, unknown>> {
	const options = { type: 'RsaSignature2017', creator: key.creator, nonce, created: created.toISOString() };
	const transformedOptions: Record<string, unknown> = { ...options, '@context': 'https://w3id.org/identity/v1' };
	delete transformedOptions.type;
	delete transformedOptions.id;
	delete transformedOptions.signatureValue;
	const document = { ...activity };
	delete document.signature;

	const normalize = async (value: Record<string, unknown>) => {
		const canonical = await jsonld.normalize(value as JsonLdDocument, { documentLoader: loadBundledJsonLdContext });
		return createHash('sha256').update(canonical).digest('hex');
	};
	const verificationData = await normalize(transformedOptions) + await normalize(document);
	const signatureValue = sign('RSA-SHA256', Buffer.from(verificationData, 'utf8'), key.privateKeyPem).toString('base64');
	return { ...activity, signature: { ...options, signatureValue } };
}
