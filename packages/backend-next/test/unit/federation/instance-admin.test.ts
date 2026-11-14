/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import observations from '../../../../../docs/superpowers/compatibility/remote-user/instance-admin-observations.json' with { type: 'json' };
import { createInstanceAdmin } from '../../../src/modules/federation/public.js';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import type { InstanceAdminSnapshot } from '../../../src/modules/federation/public.js';

test('source observations bind the fixed revision and the exact probe bytes', () => {
	expect(observations.source).toBe('8e07cf085adf7009583d234a208e30436f020e26');
	const bytes = readFileSync(new URL('../../../../../docs/superpowers/compatibility/remote-user/instance-admin-source-probe.mjs', import.meta.url));
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(observations.probeSha256);
	expect(new Set(observations.cases.map(c => c.id)).size).toBe(observations.cases.length);
});

const source = new DataSource({ type: 'postgres' });
for (const raw of observations.cases) {
	const c = raw as typeof raw & { state?: InstanceAdminSnapshot['suspensionState']; host?: string; missing?: boolean; fail?: string };
	test(`fixed upstream instance admin: ${c.id}`, async () => {
		const row: InstanceAdminSnapshot = { id: 'instance1', host: c.host ?? 'remote.test', suspensionState: c.state ?? 'none', moderationNote: 'before' };
		const audits: unknown[] = []; const refresh: unknown[] = []; const lookups: string[] = []; let error = null;
		const application = createInstanceAdmin({
			authorizationFacts: async () => ({ isSuspended: false, isModerator: true, isAdministrator: false }),
			read: async host => {
				lookups.push(host);
				if (c.fail === 'read') {
					throw Error('read rejected');
				}
				return c.missing ? null : structuredClone(row);
			},
			update: async (_id, patch) => {
				source.createQueryBuilder().update('instance').set(patch).returning('*').getQuery();
				if (c.fail === 'db') {
					throw Error('DB rejected');
				}
				Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([,v]) => v !== undefined)));
			},
			startAudit: ({ occurredAtMs: _at, ...entry }) => {
 audits.push(entry); 
},
			startMetadata: instance => {
 refresh.push({ id: instance.id, host: instance.host, force: true }); 
},
			clock: () => 1000,
		});
		const access = createAccessRequest({ requireModerator: true, kind: 'write:admin:federation' }, { userId: 'moderator1', native: true });
		try {
			await (c.operation === 'update-instance' ? application.updateInstance(access, c.input) : application.refreshMetadata(access, c.input));
		} catch (e) {
			error = { name: (e as Error).name, message: (e as Error).message };
		}
		expect({ row, audits, refresh, lookups, error }).toEqual(c.expected);
	});
}
