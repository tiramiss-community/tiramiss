/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { OutboundStatusError } from '../../application/outbound-http.js';

/** 配送が成功したときのジョブの結果。本家のジョブの返り値と同じ文字列。 */
export const deliverySucceeded = 'Success';

export type DeliveryFailure =
	/** 再試行しない。`hostGone` なら送信先のホストを goneSuspended にする。 */
	| { kind: 'stop'; message: string; hostGone: boolean }
	/** `error` を失敗理由として再試行する。 */
	| { kind: 'retry'; error: unknown };

/**
 * 署名付き送信が投げた例外を、配送ジョブの扱いへ分類する。
 * StatusError 以外（DNS・接続・timeout・遮断・鍵の読み取りなど）は、元の例外のまま再試行する。
 */
export function classifyDeliveryFailure(target: { to: string; isSharedInbox: boolean }, error: unknown): DeliveryFailure {
	// 本家は instanceof で判定する。name と statusCode を持つだけの例外は、StatusError として扱わない。
	if (!(error instanceof OutboundStatusError)) {
		return { kind: 'retry', error };
	}

	if (error.isRetryable) {
		return { kind: 'retry', error: new Error(`${error.statusCode} ${error.statusMessage}`) };
	}

	if (target.isSharedInbox && error.statusCode === 410) {
		// 本家は toPuny を通さない url.host を使う。ポートは残り、大文字・IDN は URL の解釈で正規化される。
		return { kind: 'stop', message: `${new URL(target.to).host} is gone`, hostGone: true };
	}
	return { kind: 'stop', message: `${error.statusCode} ${error.statusMessage}`, hostGone: false };
}
