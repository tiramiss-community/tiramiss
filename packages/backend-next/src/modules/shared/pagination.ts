/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface PaginationInput {
	sinceId?: string | null;
	untilId?: string | null;
	sinceDate?: number | null;
	untilDate?: number | null;
}

export interface PaginationPlan {
	/** Exclusive ID bounds, using the configured ID generator for date cursors. */
	sinceId?: string;
	untilId?: string;
	order: 'ASC' | 'DESC';
}

export function planPagination(input: PaginationInput, idFromDate: (date: number) => string): PaginationPlan {
	let sinceId: string | undefined;
	let untilId: string | undefined;
	if (input.sinceId || input.untilId) {
		sinceId = input.sinceId || undefined;
		untilId = input.untilId || undefined;
	} else {
		sinceId = input.sinceDate ? idFromDate(input.sinceDate) : undefined;
		untilId = input.untilDate ? idFromDate(input.untilDate) : undefined;
	}
	return { ...(sinceId ? { sinceId } : {}), ...(untilId ? { untilId } : {}), order: sinceId && !untilId ? 'ASC' : 'DESC' };
}
