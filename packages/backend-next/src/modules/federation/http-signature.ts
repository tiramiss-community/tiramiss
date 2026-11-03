/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash, sign } from 'node:crypto';
import { promisify } from 'node:util';

export interface HttpSignatureKey {
	privateKeyPem: string;
	keyId: string;
}

export interface SignedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
}

export interface SignedHttpRequest {
	request: SignedRequest;
	signingString: string;
	signature: string;
	signatureHeader: string;
}

// 同期版の sign は event loop を止める。本家の slacc も別スレッドで署名するため、libuv のスレッドで動く callback 版を使う。
const signAsync = promisify(sign);

const activityAccept = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export function createDigest(body: string): string {
	return `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
}

export async function createSignedPost(
	args: { key: HttpSignatureKey; url: string; body: string; digest?: string; additionalHeaders: Record<string, string> },
	now: Date,
): Promise<SignedHttpRequest> {
	const url = new URL(args.url);
	// 渡された digest は本文と照合しない。空文字列もそのまま使う。
	const digest = args.digest ?? createDigest(args.body);

	const request: SignedRequest = {
		url: url.href,
		method: 'POST',
		headers: assignLowerCased({
			'Date': now.toUTCString(),
			'Host': url.host,
			'Content-Type': 'application/activity+json',
			'Digest': digest,
		}, args.additionalHeaders),
	};

	return signRequest(request, args.key, ['(request-target)', 'date', 'host', 'digest']);
}

export async function createSignedGet(
	args: { key: HttpSignatureKey; url: string; additionalHeaders: Record<string, string> },
	now: Date,
): Promise<SignedHttpRequest> {
	const url = new URL(args.url);

	const request: SignedRequest = {
		url: url.href,
		method: 'GET',
		headers: assignLowerCased({
			'Accept': activityAccept,
			'Date': now.toUTCString(),
			'Host': url.host,
		}, args.additionalHeaders),
	};

	return signRequest(request, args.key, ['(request-target)', 'date', 'host']);
}

async function signRequest(request: SignedRequest, key: HttpSignatureKey, includeHeaders: string[]): Promise<SignedHttpRequest> {
	const signingString = signingStringOf(request, includeHeaders);
	const signature = (await signAsync('sha256', Buffer.from(signingString), key.privateKeyPem)).toString('base64');
	const signatureHeader = `keyId="${key.keyId}",algorithm="rsa-sha256",headers="${includeHeaders.join(' ')}",signature="${signature}"`;

	const headers = assignLowerCased(request.headers, { Signature: signatureHeader });
	// Host は送信側が宛先から作る。署名した値を残すと、redirect 先へも元の Host を送ってしまう。
	delete headers.host;

	return {
		request: { ...request, headers },
		signingString,
		signature,
		signatureHeader,
	};
}

function signingStringOf(request: SignedRequest, includeHeaders: string[]): string {
	return includeHeaders.map(name => {
		if (name !== '(request-target)') {
			return `${name}: ${request.headers[name]}`;
		}

		// fragment は送られないので含めない。空の `?` は送られるので残す。
		const url = new URL(request.url);
		const query = url.search || (url.href.split('#', 1)[0].endsWith('?') ? '?' : '');
		return `(request-target): ${request.method.toLowerCase()} ${url.pathname}${query}`;
	}).join('\n');
}

// 呼び出し元の値は JSON 由来のこともあるため、型に反する値（文字列以外・`__proto__`）を本家と同じく捨てる。
function lowerCased(source: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of Object.keys(source)) {
		if (key === '__proto__' || typeof source[key] !== 'string') {
			continue;
		}
		result[key.toLowerCase()] = source[key];
	}
	return result;
}

function assignLowerCased(base: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
	return Object.assign(lowerCased(base), lowerCased(overrides));
}
