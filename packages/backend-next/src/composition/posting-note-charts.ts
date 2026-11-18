/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { ChartNote, createNoteCharts } from '../modules/chart/public.js';

export function createPostingNoteCharts(charts: Pick<ReturnType<typeof createNoteCharts>, 'update' | 'updateUser'>, readRemoteEnabled: () => Promise<boolean>) {
	return async (note: ChartNote, additional: boolean, authorHost = note.userHost): Promise<void> => {
		// The global chart and local author's chart do not depend on fetching remote settings.
		charts.update(note, additional, false, authorHost);
		if (authorHost !== null && (!additional || note.visibility !== 'specified') && await readRemoteEnabled()) {
			charts.updateUser(note, additional);
		}
	};
}
