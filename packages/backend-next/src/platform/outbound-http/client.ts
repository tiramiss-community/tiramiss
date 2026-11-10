/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import fetch from 'node-fetch';
import { OutboundStatusError } from '../../application/outbound-http.js';
import type { OutboundHttp, OutboundResponse, OutboundSend } from '../../application/outbound-http.js';
import type { OutboundAgents } from './agents.js';
import type { BodyInit, Response } from 'node-fetch';

const defaultMaxBytes = 10 * 1024 * 1024;
const jsonMaxBytes = 256 * 1024;

function toOutboundResponse(response: Response): OutboundResponse {
	return {
		status: response.status,
		statusText: response.statusText,
		finalUrl: response.url,
		header: name => response.headers.get(name),
		text: () => response.text(),
		json: () => response.json(),
	};
}

export function createOutboundHttp(agents: OutboundAgents, userAgent: string): OutboundHttp {
	const send: OutboundSend = async (url, options = {}, extra = {}) => {
		const controller = new AbortController();
		// 応答を返した後も解除しない。本文は呼び出し側が後で読むため、解除すると読み取り中の timeout が効かなくなる。
		// unref は、使い終わった timer が終了処理を timeout まで引き延ばさないようにするだけで、打ち切りには影響しない。
		setTimeout(() => {
			controller.abort();
		}, options.timeoutMs ?? 5000).unref();

		const allowLocalAddress = options.allowLocalAddress ?? false;

		// 例外は包まずに送出する。node-fetch の message が配送の失敗理由・ログとして本家と揃う。
		const response = await fetch(url, {
			method: options.method ?? 'GET',
			// 大文字小文字を無視して置き換えない。本家はキーが `User-Agent` と完全に一致するときだけ置き換わり、
			// `user-agent` などでは両方の値を送る。宛先によって結果が変わりうるため、そのまま揃える。
			headers: {
				'User-Agent': userAgent,
				...(options.headers ?? {}),
			},
			body: options.body as BodyInit | undefined,
			size: options.maxBytes ?? defaultMaxBytes,
			agent: target => {
				options.validateUrl?.(target);
				return agents.agentByUrl(target, false, allowLocalAddress);
			},
			signal: controller.signal,
		});

		if (!response.ok && (extra.okOnly ?? true)) {
			throw new OutboundStatusError(`${response.status} ${response.statusText}`, response.status, response.statusText);
		}

		const result = toOutboundResponse(response);
		if (response.ok) {
			for (const validate of extra.validators ?? []) {
				validate(result);
			}
		}

		return result;
	};

	return {
		send,
		async getHtml(url, accept = 'text/html, */*', headers, allowLocalAddress = false) {
			const response = await send(url, { method: 'GET', headers: Object.assign({ Accept: accept }, headers ?? {}), timeoutMs: 5000, allowLocalAddress });
			return await response.text();
		},
		async getJson(url, accept = 'application/json, */*', headers) {
			const response = await send(url, {
				method: 'GET',
				headers: Object.assign({ Accept: accept }, headers ?? {}),
				timeoutMs: 5000,
				maxBytes: jsonMaxBytes,
			});
			return await response.json();
		},
	};
}
