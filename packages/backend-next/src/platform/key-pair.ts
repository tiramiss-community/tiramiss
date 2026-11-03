/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPrivateKey, generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';

export interface RsaKeyPair {
	publicKeyPem: string;
	privateKeyPem: string;
}

const generate = promisify(generateKeyPair);

export async function generateRsaKeyPair(): Promise<RsaKeyPair> {
	const { publicKey, privateKey } = await generate('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

// 本家と同じく見出しの文字列だけで旧形式を判定する。PEMを解析して判定すると、本家が変換しない鍵まで書き換え対象になる。
export function upgradePkcs1PrivateKeyPem(pem: string): string | null {
	if (!pem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
		return null;
	}
	return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs1' }).export({ format: 'pem', type: 'pkcs8' }) as string;
}
