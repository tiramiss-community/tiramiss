/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createSignedPost } from './http-signature.js';
import type { OutboundSend } from '../../application/outbound-http.js';

/** 本家の ApRequestService.signedPost。非 2xx は OutboundStatusError、それ以外の失敗は送信元の例外をそのまま投げる。 */
export type SignedPost = (user: { id: string }, url: string, object: unknown, digest?: string) => Promise<void>;

export function createSignedPostSender(ports: {
	readUserKeypair: (userId: string) => Promise<{ privateKeyPem: string }>;
	send: OutboundSend;
	/** 末尾の `/` を持たない origin。keyId の組み立てに使う。 */
	selfUrl: string;
	clock: () => number;
}): SignedPost {
	return async (user, url, object, digest) => {
		const body = typeof object === 'string' ? object : JSON.stringify(object);
		const keypair = await ports.readUserKeypair(user.id);

		const signed = await createSignedPost({
			key: { privateKeyPem: keypair.privateKeyPem, keyId: `${ports.selfUrl}/users/${user.id}#main-key` },
			url,
			body,
			digest,
			additionalHeaders: {},
		}, new Date(ports.clock()));

		// 正規化した request.url ではなく元の url へ送る。本家と同じく、fragment・userinfo の扱いを送信側に任せる。
		// 応答本文は読まない。timeout・redirect・宛先の検査は send が受け持つ。
		await ports.send(url, { method: signed.request.method, headers: signed.request.headers, body });
	};
}
