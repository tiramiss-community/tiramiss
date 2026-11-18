/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createAccessRequest, InputInvalid } from '../../src/modules/access/public.js';
import { createPromoRead } from '../../src/modules/promo/public.js';
import corpus from '../../../../docs/superpowers/compatibility/promo-read/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/promo-read/observations.json' with { type: 'json' };

for (const observation of observations.cases) {
	test(`matches pinned source state/error: ${observation.id}`, async () => {
		const item = corpus.cases.find(item => item.id === observation.id)!;
		const rows: Array<{ id: string; noteId: string; userId: string }> = structuredClone(item.rows);
		const fail = (operation: string) => {
			if (item.fail === operation) {
				throw Error(`${operation} unavailable`);
			}
		};
		const app = createPromoRead({
			readActor: async () => ({ isSuspended: false, isModerator: true, isAdministrator: false }),
			noteExists: async id => {
				fail('note');
				return corpus.notes.some(note => note.id === id);
			},
			readExists: async (noteId, userId) => {
				fail('exists');
				return rows.some(row => row.noteId === noteId && row.userId === userId);
			},
			insertRead: async row => {
				fail('insert');
				rows.push(row);
			},
			newId: () => 'generated',
		});
		let error;
		try {
			await app.read(createAccessRequest(observations.access, { userId: item.userId ?? 'reader', native: true }), structuredClone(item.input));
		} catch (caught) {
			const e = caught as Error & { code?: string; id?: string };
			error = e instanceof InputInvalid ? { code: 'INVALID_PARAM' } : e.code ? { code: e.code, id: e.id } : { message: e.message };
		}
		rows.sort((a, b) => a.noteId.localeCompare(b.noteId) || a.userId.localeCompare(b.userId));
		expect({ id: item.id, ...(error ? { error } : {}), rows }).toEqual(observation);
	});
}
