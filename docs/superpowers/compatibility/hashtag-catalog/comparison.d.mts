/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
interface ComparisonCase {
	id: string;
	endpoint: string;
	input: Record<string, unknown>;
}
interface ComparisonRow {
	name: string;
	[column: string]: unknown;
}
export function canonicalizeHashtagResult(item: ComparisonCase, result: unknown, rows: readonly ComparisonRow[]): unknown;
export function canonicalizeHashtagObservations(output: { cases: Array<{ id: string; result?: unknown }> }, corpus: { cases: ComparisonCase[]; rows: ComparisonRow[] }): unknown;
