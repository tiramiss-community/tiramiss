/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPublicKey } from 'node:crypto';

// 保存済みの公開鍵には旧形式（PKCS#1）が残り得る。本家は公開時に毎回SPKIへ変換しており、保存値は書き換えない。
export function toSpkiPublicKeyPem(pem: string): string {
	return createPublicKey(pem).export({ type: 'spki', format: 'pem' });
}
