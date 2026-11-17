/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { planPagination } from '../../../src/modules/shared/pagination.js';
import type { PaginationInput, PaginationPlan } from '../../../src/modules/shared/pagination.js';

const observations = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/notes-pagination/observations.json', import.meta.url), 'utf8')) as { cursors: { input: PaginationInput; plan: PaginationPlan }[] };
test.each(observations.cursors)('pinned QueryService cursor $input', ({ input, plan }) => {
	expect(planPagination(input, date => `date${date}`)).toEqual(plan);
});

test.each([
	[{}, { order: 'DESC' }],
	[{ sinceId: 'b' }, { sinceId: 'b', order: 'ASC' }],
	[{ untilId: 'd' }, { untilId: 'd', order: 'DESC' }],
	[{ sinceId: 'b', untilId: 'd', sinceDate: 10, untilDate: 20 }, { sinceId: 'b', untilId: 'd', order: 'DESC' }],
	[{ sinceId: 'b', untilDate: 20 }, { sinceId: 'b', order: 'ASC' }],
	[{ untilId: 'd', sinceDate: 10 }, { untilId: 'd', order: 'DESC' }],
	[{ sinceDate: 10 }, { sinceId: 'date10', order: 'ASC' }],
	[{ untilDate: 20 }, { untilId: 'date20', order: 'DESC' }],
	[{ sinceDate: 10, untilDate: 20 }, { sinceId: 'date10', untilId: 'date20', order: 'DESC' }],
	[{ sinceDate: 0, untilDate: 0 }, { order: 'DESC' }],
	[{ sinceDate: null, untilId: null }, { order: 'DESC' }],
])('pagination %j', (input, expected) => {
	expect(planPagination(input, date => `date${date}`)).toEqual(expected);
});
