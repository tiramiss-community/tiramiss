/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type OutboundBody = string | Uint8Array | FormData | URLSearchParams;

export interface OutboundSendOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: OutboundBody;
	timeoutMs?: number;
	maxBytes?: number;
	allowLocalAddress?: boolean;
}

export interface OutboundResponse {
	status: number;
	statusText: string;
	finalUrl: string;
	header(name: string): string | null;
	/** 本文は呼び出し時に読む。maxBytes の超過と timeout は、ここで失敗として現れる。 */
	text(): Promise<string>;
	json(): Promise<unknown>;
}

export interface OutboundSendExtra {
	okOnly?: boolean;
	/** 2xx のときだけ、本文を読む前に実行する。 */
	validators?: ((response: OutboundResponse) => void)[];
}

export type OutboundSend = (url: string, options?: OutboundSendOptions, extra?: OutboundSendExtra) => Promise<OutboundResponse>;
export type OutboundGetJson = (url: string, accept?: string, headers?: Record<string, string>) => Promise<unknown>;

export interface OutboundHttp {
	send: OutboundSend;
	getJson: OutboundGetJson;
}

export class OutboundStatusError extends Error {
	readonly statusCode: number;
	readonly statusMessage?: string;
	readonly isClientError: boolean;
	readonly isRetryable: boolean;

	constructor(message: string, statusCode: number, statusMessage?: string) {
		super(message);
		// 配送の失敗理由・ログに現れる名前を本家の StatusError と揃えるため、クラス名には合わせない。
		this.name = 'StatusError';
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
		this.isClientError = statusCode >= 400 && statusCode < 500;
		this.isRetryable = !this.isClientError || statusCode === 429;
	}
}
