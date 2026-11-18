/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createAccessRequest, InputInvalid } from '../../src/modules/access/public.js';
import { createPromo } from '../../src/modules/promo/public.js';
import corpus from '../../../../docs/superpowers/compatibility/promo/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/promo/observations.json' with { type: 'json' };

for (const observation of observations.cases) {
	test(`matches pinned source state/error: ${observation.id}`, async () => {
		const item = corpus.cases.find(item => item.id === observation.id)!;
		const rows: Array<{ noteId: string; userId: string; expiresAt: number }> = structuredClone(item.rows);
		const fail = (operation: string) => {
			if (item.fail === operation) {
				throw Error(`${operation} unavailable`);
			}
		};
		const app = createPromo({
			readActor: async () => ({ isSuspended: false, isModerator: true, isAdministrator: false }),
			readNote: async id => {
				fail('note');
				return corpus.notes.find(note => note.id === id) ?? null;
			},
			exists: async noteId => {
				fail('exists');
				return rows.some(row => row.noteId === noteId);
			},
			insert: async row => {
				fail('insert');
				rows.push({ ...row, expiresAt: row.expiresAt.getTime() });
			},
		});
		let error;
		try {
			await app.create(createAccessRequest(observations.access, { userId: 'moderator', native: true }), structuredClone(item.input));
		} catch (caught) {
			const e = caught as Error & { code?: string; id?: string };
			error = e instanceof InputInvalid ? { code: 'INVALID_PARAM' } : e.code ? { code: e.code, id: e.id } : { message: e.message };
		}
		expect({ id: item.id, ...(error ? { error } : {}), rows }).toEqual(observation);
	});
}
