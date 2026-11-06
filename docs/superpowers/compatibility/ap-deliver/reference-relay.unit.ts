/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, vi } from 'vitest';
import { JsonLd } from '@/core/activitypub/JsonLdService.js';
import { PRELOADED_CONTEXTS } from '@/core/activitypub/misc/contexts.js';
import { RelayService } from '@/core/RelayService.js';

vi.mock('re2', () => ({ default: class {} }));
const requireUpstream = createRequire(`${process.env.AP_RELAY_UPSTREAM_ROOT}/packages/backend/package.json`);
requireUpstream('slacc').init(1);
const nonce = '00112233445566778899aabbccddeeff';
vi.mock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>(), randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex') }));
const keys = JSON.parse(readFileSync(new URL('../ap-request/test-only-keypair.json', import.meta.url), 'utf8'));
const render = JSON.parse(readFileSync(new URL('./render-cases.json', import.meta.url), 'utf8'));
const write = process.env.AP_RELAY_PROBE_WRITE === '1';
function settle(name: string, actual: unknown) {
	const path = new URL(name, import.meta.url);
	if (write) {
		writeFileSync(path, JSON.stringify(actual, null, '\t') + '\n');
	} else {
		expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')));
	}
}

test('fixed upstream canonicalization, signing and verification', async () => {
	const ld = new JsonLd({ send: () => {
		throw new Error('unexpected context fetch');
	} } as never);
	const base = JSON.parse(render.cases.find((c: { id: string }) => c.id === 'public-plain').activity);
	const announce = JSON.parse(render.cases.find((c: { activity: string | null }) => c.activity && JSON.parse(c.activity).type === 'Announce').activity);
	const inputs = {
		contexts: PRELOADED_CONTEXTS,
		creator: `${render.inputs.selfUrl}/users/${render.inputs.cases[0].note.userId}#main-key`,
		created: '2026-11-06T01:02:03.000Z', nonce,
		activities: [base, announce, { ...base, object: { ...base.object, content: '雪 ☃ café <b>日本語</b>', attachment: [{ type: 'Document', mediaType: 'image/png', url: 'https://example.test/雪.png', name: '画像' }] } }, { ...base, signature: { type: 'ignored', signatureValue: 'old' } }],
	};
	const cases = [];
	for (const activity of inputs.activities) {
		const signed = await ld.signRsaSignature2017(activity, keys.privateKeyPem, inputs.creator, undefined, new Date(inputs.created));
		const options = { ...signed.signature, '@context': 'https://w3id.org/identity/v1' };
		delete options.type;
		delete options.id;
		delete options.signatureValue;
		const document = { ...activity };
		delete document.signature;
		const canonicalOptions = await ld.normalize(options);
		const canonicalDocument = await ld.normalize(document);
		const hash = (value: string) => createHash('sha256').update(value).digest('hex');
		cases.push({ canonicalOptions, canonicalDocument, optionsHash: hash(canonicalOptions), documentHash: hash(canonicalDocument), verificationData: await ld.createVerifyData(activity, signed.signature), signed, verified: await ld.verifyRsaSignature2017(signed, keys.publicKeyPem) });
	}
	settle('ld-signature-cases.json', { inputs, cases });
});

test('fixed upstream relay producer observations', async () => {
	const author = { id: 'alice', host: null };
	const inputs = { author, cases: [null, {}, { to: null }, { to: '' }, { to: false }, { to: 0 }, { to: [] }, { to: ['https://example.test/a'] }, { object: { content: 'original' } }] };
	const cases = [];
	for (const activity of inputs.cases) {
		for (const relays of [[], [{ inbox: 'https://relay.test/inbox' }, { inbox: 'https://second.test/inbox' }]]) {
			const calls: unknown[] = [];
			const original = structuredClone(activity);
			const service = new RelayService({ findBy: async (where: unknown) => {
				calls.push(['findBy', where]);
				return relays;
			} } as never, {} as never,
			{ deliver: (...args: unknown[]) => {
				calls.push(['deliver', ...args]);
				return Promise.resolve();
			} } as never, {} as never,
			{ attachLdSignature: async (copy: Record<string, unknown>, user: unknown) => {
				calls.push(['sign', structuredClone(copy), user, copy !== activity]);
				if (copy.object) {
					(copy.object as Record<string, unknown>).content = 'changed';
				}
				return { ...copy, signature: 'signed' };
			} } as never);
			await service.deliverToRelays(author, activity);
			expect(activity).toEqual(original);
			cases.push({ activity, relays, calls });
		}
	}
	for (const mode of ['async-rejection', 'sync-throw']) {
		const attempted: string[] = [];
		const service = new RelayService({ findBy: async () => [{ inbox: 'first' }, { inbox: 'second' }] } as never, {} as never,
			{ deliver: (_user: unknown, _activity: unknown, to: string) => {
				attempted.push(to);
				if (to === 'first') {
					if (mode === 'sync-throw') {
						throw new Error('add');
					}
					const rejected = Promise.reject(new Error('add'));
					void rejected.catch(() => {});
					return rejected;
				}
				return Promise.resolve();
			} } as never, {} as never,
			{ attachLdSignature: async (copy: unknown) => copy } as never);
		let rejected = false;
		try {
			await service.deliverToRelays(author, {});
		} catch {
			rejected = true;
		}
		cases.push({ mode, attempted, rejected });
	}
	settle('relay-cases.json', { inputs, cases });
});
