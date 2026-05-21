/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { formatDatetimeLocal } from '@/ui/deck/past-timeline-window.js';

describe('deck past timeline window', () => {
	it('formats a Date for datetime-local input using local time', () => {
		const date = new Date(2026, 4, 9, 8, 7, 6);

		expect(formatDatetimeLocal(date)).toBe('2026-05-09T08:07');
	});
});
