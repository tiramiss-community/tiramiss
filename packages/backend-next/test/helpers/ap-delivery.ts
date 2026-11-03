/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect } from 'vitest';
import type { DeliveryFailure, deliverySucceeded } from '../../src/modules/federation/public.js';

/** docs/superpowers/compatibility/ap-request/ に記録した本家 DeliverProcessorService の結果。 */
export type UpstreamDelivery =
	| { returned: string; goneSuspended: boolean }
	| { thrown: { name: string; message: string; unrecoverable: boolean; original: boolean }; goneSuspended: boolean };

// 本家は BullMQ の UnrecoverableError で止め、Error か元の例外で再試行する。新実装は BullMQ の型を持たない値で返すため、両方を同じ形へ読み替える。
function readUpstream(expected: UpstreamDelivery) {
	if ('returned' in expected) {
		return { kind: 'success', result: expected.returned, hostGone: expected.goneSuspended };
	}
	const { name, message, unrecoverable, original } = expected.thrown;
	return unrecoverable
		? { kind: 'stop', message, hostGone: expected.goneSuspended }
		: { kind: 'retry', name, message, original, hostGone: expected.goneSuspended };
}

function readActual(outcome: typeof deliverySucceeded | DeliveryFailure, thrown: unknown) {
	if (typeof outcome === 'string') {
		return { kind: 'success', result: outcome, hostGone: false };
	}
	if (outcome.kind === 'stop') {
		return { kind: 'stop', message: outcome.message, hostGone: outcome.hostGone };
	}
	const error = outcome.error as Error;
	return { kind: 'retry', name: error.name, message: error.message, original: outcome.error === thrown, hostGone: false };
}

/** `normalize` は、実行ごとに変わる値（偽サーバーのポート）を記録時の名前へ戻す。 */
export function expectUpstreamDelivery(
	outcome: typeof deliverySucceeded | DeliveryFailure,
	thrown: unknown,
	expected: UpstreamDelivery,
	normalize: (value: string) => string = value => value,
) {
	expect(JSON.parse(normalize(JSON.stringify(readActual(outcome, thrown))))).toEqual(readUpstream(expected));
}
