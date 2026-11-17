/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createAccessRequest, InputInvalid } from '../../src/modules/access/public.js';
import { createUserMemo } from '../../src/modules/user-memo/public.js';
import corpus from '../../../../docs/superpowers/compatibility/user-memo/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/user-memo/observations.json' with { type: 'json' };
import type { UserMemoRow } from '../../src/modules/user-memo/public.js';

for (const observation of observations.cases) {
	test(`update matches fixed upstream state/error: ${observation.id}`, async () => {
		const item = corpus.cases.find(item => item.id === observation.id)!;
		let rows: UserMemoRow[] = structuredClone(item.rows);
		const fail = (operation: string) => {
			if (item.fail === operation) {
				throw Error(`${operation} unavailable`);
			}
		};
		const app = createUserMemo({
			readActor: async () => ({ isSuspended: false, isModerator: false, isAdministrator: false }),
			targetExists: async id => {
				fail('target'); return corpus.users.includes(id); 
			},
			readPrevious: async (userId, targetUserId) => {
				fail('find'); return rows.find(row => row.userId === userId && row.targetUserId === targetUserId) ?? null; 
			},
			insert: async row => {
				fail('insert'); rows.push(row); 
			},
			update: async row => {
				fail('update'); rows = rows.map(previous => previous.id === row.id ? row : previous); 
			},
			delete: async (userId, targetUserId) => {
				fail('delete'); rows = rows.filter(row => row.userId !== userId || row.targetUserId !== targetUserId); 
			},
			newId: () => corpus.newId,
		});
		let error;
		try {
			await app.update(createAccessRequest(observations.access, { userId: corpus.actorId, native: true }), structuredClone(item.input));
		} catch (caught) {
			const e = caught as Error & { code?: string; id?: string };
			error = e instanceof InputInvalid ? { code: 'INVALID_PARAM' } : e.code ? { code: e.code, ...(e.id ? { id: e.id } : {}) } : { message: e.message };
		}
		expect(JSON.parse(JSON.stringify({ id: item.id, ...(error ? { error } : {}), rows }))).toEqual(
			Object.fromEntries(Object.entries(observation).filter(([key]) => key !== 'reads')),
		);
	});
}

test('suspension and scope checks precede invalid memo input and cannot mutate state', async () => {
	for (const suspended of [true, false]) {
		const app = createUserMemo({
			readActor: async () => ({ isSuspended: suspended, isModerator: false, isAdministrator: false }),
			targetExists: async () => {
				throw Error('must not reach target'); 
			},
			readPrevious: async () => {
				throw Error('must not read memo'); 
			},
			insert: async () => {
				throw Error('must not insert'); 
			},
			update: async () => {
				throw Error('must not update'); 
			},
			delete: async () => {
				throw Error('must not delete'); 
			},
			newId: () => {
				throw Error('must not generate id'); 
			},
		});
		await expect(app.update(createAccessRequest(observations.access, { userId: 'alice', native: false, permissions: new Set() }), {}))
			.rejects.toMatchObject({ reason: suspended ? 'YOUR_ACCOUNT_SUSPENDED' : 'PERMISSION_DENIED' });
	}
});
