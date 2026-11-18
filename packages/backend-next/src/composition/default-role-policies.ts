/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createUpdateDefaultPolicies, roleAccessFacts } from '../modules/role/public.js';
import { readRoleAuthorizationFacts } from '../platform/database/role-authorization-facts.js';
import { replaceDefaultRolePolicies } from '../platform/database/default-role-policies.js';
import { appendModerationLog } from '../platform/database/moderation-log.js';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { readMeta } from '../platform/database/meta.js';
import type { createMetaCache } from '../platform/meta-cache.js';
import type { Logger } from '../platform/logger.js';
export function createDefaultRolePolicies(parts: {
	dataSource: DataSource;
	meta: Pick<ReturnType<typeof createMetaCache>, 'refresh'>;
	publisher: Pick<Redis, 'publish'>;
	url: string;
	logger: Logger;
	ids: {
		createdAtFromId(id: string): number;
		newId(atMs: number): string;
	};
}) {
	const pending = new Set<Promise<void>>();

	function track(work: Promise<unknown>, stage: string): void {
		const task = work.then(() => { }, error => {
			try {
				parts.logger.error('default-role-policies.failed', { stage, error });
			} catch { /* Diagnostics cannot leave accepted work undrained. */ }
		});
		pending.add(task);
		void task.then(() => pending.delete(task), () => pending.delete(task));
	}

	function publish(type: string, body: object): void {
		track(parts.publisher.publish(new URL(parts.url).host, JSON.stringify({ channel: 'internal', message: { type, body } })), type);
	}

	const application = createUpdateDefaultPolicies({
		authorizationFacts: async (actorId) => roleAccessFacts(actorId, await readRoleAuthorizationFacts(parts.dataSource.manager, actorId, parts.ids.createdAtFromId), Date.now()),
		readPolicies: async () => structuredClone((await parts.meta.refresh(() => parts.dataSource.transaction(readMeta))).policies),
		replacePolicies: async (policies) => {
			const { before, after } = await replaceDefaultRolePolicies(parts.dataSource, policies);
			publish('metaUpdated', { before, after });
		},
		startPolicyNotification: policies => publish('policiesUpdated', policies),
		startAudit: entry => track(appendModerationLog(parts.dataSource.manager, entry, parts.ids.newId), 'audit'),
		clock: Date.now,
	});

	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return { ...application, idle, close: idle };
}
