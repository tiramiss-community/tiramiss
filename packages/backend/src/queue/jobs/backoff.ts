/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * HTTP関連ジョブ用のバックオフ戦略。
 * 指数バックオフ + ジッターで、最大8時間まで待機。
 *
 * ref. https://github.com/misskey-dev/misskey/pull/7635#issue-971097019
 */
export function httpRelatedBackoff(attemptsMade: number): number {
	const baseDelay = 60 * 1000; // 1min
	const maxBackoff = 8 * 60 * 60 * 1000; // 8hours
	let backoff = (Math.pow(2, attemptsMade) - 1) * baseDelay;
	backoff = Math.min(backoff, maxBackoff);
	backoff += Math.round(backoff * Math.random() * 0.2);
	return backoff;
}
