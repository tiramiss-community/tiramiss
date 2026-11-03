/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { toSpkiPublicKeyPem } from '../../../src/modules/federation/public.js';
import { generateRsaKeyPair, upgradePkcs1PrivateKeyPem } from '../../../src/platform/key-pair.js';

const legacy = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

describe('generateRsaKeyPair', () => {
	test('creates a 2048-bit RSA pair as SPKI public and PKCS#8 private PEM', async () => {
		const pair = await generateRsaKeyPair();

		expect(pair.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
		expect(pair.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		expect(createPrivateKey(pair.privateKeyPem).asymmetricKeyDetails).toEqual({ modulusLength: 2048, publicExponent: 65537n });
	});

	test('a signature made with the private key verifies with the public key', async () => {
		const pair = await generateRsaKeyPair();
		const data = Buffer.from('(request-target): post /inbox');
		const signature = sign('sha256', data, pair.privateKeyPem);

		expect(verify('sha256', data, pair.publicKeyPem, signature)).toBe(true);
		expect(verify('sha256', Buffer.from('tampered'), pair.publicKeyPem, signature)).toBe(false);
	});
});

describe('upgradePkcs1PrivateKeyPem', () => {
	test('converts a PKCS#1 private key to PKCS#8 holding the same key', () => {
		const upgraded = upgradePkcs1PrivateKeyPem(legacy.privateKey);

		expect(upgraded).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		const data = Buffer.from('payload');
		expect(verify('sha256', data, legacy.publicKey, sign('sha256', data, upgraded!))).toBe(true);
	});

	test('leaves a PKCS#8 private key untouched', async () => {
		const pair = await generateRsaKeyPair();

		expect(upgradePkcs1PrivateKeyPem(pair.privateKeyPem)).toBeNull();
	});
});

describe('toSpkiPublicKeyPem', () => {
	test('rewrites a PKCS#1 public key as SPKI', () => {
		const spki = toSpkiPublicKeyPem(legacy.publicKey);

		expect(legacy.publicKey).toMatch(/^-----BEGIN RSA PUBLIC KEY-----\n/);
		expect(spki).toBe(createPublicKey(legacy.privateKey).export({ type: 'spki', format: 'pem' }));
	});

	test('returns an SPKI key unchanged', async () => {
		const pair = await generateRsaKeyPair();

		expect(toSpkiPublicKeyPem(pair.publicKeyPem)).toBe(pair.publicKeyPem);
	});

	test('rejects text that is not a PEM key', () => {
		expect(() => toSpkiPublicKeyPem('not a key')).toThrow();
	});
});
