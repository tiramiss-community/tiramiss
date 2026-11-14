/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiInstance } from 'backend-upstream/entities';
import { createInstanceAdmin } from '../modules/federation/public.js';
import { roleAccessFacts } from '../modules/role/public.js';
import { readRoleAuthorizationFacts } from '../platform/database/role-authorization-facts.js';
import { appendModerationLog } from '../platform/database/moderation-log.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeConfig } from '../config/types.js';
import type { DataSource } from 'typeorm';
import type { Logger } from '../platform/logger.js';
import type { InstanceLedger, InstanceMetadataTarget } from '../modules/federation/public.js';

export function createInstanceAdministration(parts: {
	dataSource: DataSource;
	ledger: InstanceLedger;
	fetchMetadata(instance: InstanceMetadataTarget, force: boolean): Promise<void>;
	logger: Logger;
	id: RuntimeConfig['id'];
}) {
	const { manager } = parts.dataSource;
	const ids = createIdCodec(parts.id);
	const pending = new Set<Promise<void>>();

	function track(work: Promise<void>, stage: string): void {
		const task = work.catch(error => parts.logger.error('instance-admin.failed', { stage, error }));
		pending.add(task);
		void task.then(() => pending.delete(task));
	}

	const application = createInstanceAdmin({
		authorizationFacts: async actorId => roleAccessFacts(actorId, await readRoleAuthorizationFacts(manager, actorId, ids.createdAtFromId), Date.now()),
		read: async host => {
			const row = await manager.getRepository(MiInstance).findOneBy({ host });
			return row === null ? null : { id: row.id, host: row.host, suspensionState: row.suspensionState, moderationNote: row.moderationNote };
		},
		update: (id, patch) => parts.ledger.updateInstance(id, patch, work => track(work, 'cache')),
		startMetadata: instance => track(parts.fetchMetadata(instance, true), 'metadata'),
		startAudit: entry => track(appendModerationLog(manager, entry, ids.newId), 'audit'),
		clock: Date.now,
	});

	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return { ...application, idle, close: idle };
}
