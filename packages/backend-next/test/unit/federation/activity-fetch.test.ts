/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { generateKeyPairSync, verify } from 'node:crypto';
import { expect, test } from 'vitest';
import { createActivitySession } from '../../../src/modules/federation/public.js';
import { remoteSource, encode, sourceNow } from '../../helpers/remote-source.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const cases = remoteSource.cases.filter((c: { area: string; }) => c.area === 'fetch');
for (const fixture of cases) {
	test(`${fixture.id} executes the actual acquisition session and compares source result and transport projections`, async () => {
		const input = fixture.input;
		let index = 0, signers = 0;
		const requests: { url: string; size?: number; timeout?: number; valid: boolean | null; }[] = [];
		const session = createActivitySession({
			signed: input.signed !== false, clock: () => sourceNow,
			isSelfHost: h => h === 'local.test', isAllowedHost: async h => h !== 'blocked.test',
			signer: async () => {
				signers++; return { keyId: 'https://local.test/users/system#main-key', privateKeyPem };
			},
			resolveLocal: async url => ({ id: url, userId: 'local' }),
			http: {
				send: async (url, options) => {
					const first = index++ === 0;
					const sig = options?.headers?.signature;
					const raw = `(request-target): get ${new URL(url).pathname}${new URL(url).search}\ndate: ${new Date(sourceNow).toUTCString()}\nhost: ${new URL(url).host}`;
					requests.push({ url, size: options?.maxBytes, timeout: options?.timeoutMs, valid: sig ? verify('sha256', Buffer.from(raw), pair.publicKey, Buffer.from(sig.match(/signature="([^"]+)"$/)![1], 'base64')) : null });
					if (input.alternateFail && !first) {
						throw new Error('alternate unavailable');
					}
					return {
						status: 200, statusText: 'OK', finalUrl: input.finalUrl ?? url,
						header: () => first && input.alternate ? 'text/html' : input.contentType ?? 'application/activity+json',
						text: async () => `<html><head><link rel="alternate" type="application/activity+json" href="${input.alternate}"></head></html>`,
						json: async () => ({ id: input.objectId ?? url, '@context': input.context ?? 'https://www.w3.org/ns/activitystreams' }),
					};
				}
			},
		});
		// Populate history through real public resolutions, never a production test hook.
		if (input.historySize) {
			for (let i = 0; i < input.historySize; i++) {
				await session.resolve(`https://remote.test/history/${i}`);
			}
		}
		const value = input.value ?? input.url ?? 'https://remote.test/a';
		if (input.repeated) {
			await session.resolve(value);
		}
		const before = requests.length;
		try {
			const first = await session.resolve(value);
			const result = input.second ? [first, await session.resolve(input.second)] : first;
			expect(fixture.expected.error).toBeUndefined();
			expect(encode(result)).toEqual(fixture.expected.result);
		} catch (error) {
			if (!fixture.expected.error) {
				throw error;
			}
			const expected = fixture.expected.error.message.replace('cannot resolve already resolved one', 'cannot resolve already resolved one');
			expect((error as Error).message).toBe(expected);
			if (fixture.expected.error.id) {
				expect((error as Error & { id?: string; }).id).toBe(fixture.expected.error.id);
			}
		}
		const projected = fixture.expected.events.filter((e: { op: string; }) => e.op === 'fetch').map((e: { args: { url: string; size: number; signatureValid: boolean | null; }; }) => ({ url: e.args.url, size: e.args.size, timeout: 5000, valid: e.args.signatureValid }));
		expect(requests.slice(before)).toEqual(projected);
		if (requests.length && input.signed !== false) {
			expect(signers).toBe(1);
		}
	});
}
