/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { toPuny } from './host.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { ModerationLogEntry } from '../audit/public.js';
import type { InstanceMetadataTarget } from './instance-metadata.js';
import type { InstancePatch, InstanceSuspensionState } from './instance.js';

export interface InstanceAdminSnapshot extends InstanceMetadataTarget {
	suspensionState: InstanceSuspensionState;
	moderationNote: string;
}

export interface InstanceAdminPorts {
	authorizationFacts(actorId: string): Promise<AccessFacts>;
	read(host: string): Promise<InstanceAdminSnapshot | null>;
	update(id: string, patch: InstancePatch): Promise<void>;
	startAudit(entry: ModerationLogEntry): void;
	startMetadata(instance: InstanceMetadataTarget): void;
	clock(): number;
}

const host = { type: 'string' };
const readUpdate = compileInput<{ host: string; isSuspended?: boolean; moderationNote?: string }>({
	type: 'object', properties: { host, isSuspended: { type: 'boolean' }, moderationNote: { type: 'string' } }, required: ['host'],
});
const readRefresh = compileInput<{ host: string }>({ type: 'object', properties: { host }, required: ['host'] });

async function authorize(ports: InstanceAdminPorts, access: AccessRequest): Promise<string> {
	const actor = requireCredential(access.credential);
	access.authorize(await ports.authorizationFacts(actor.userId));
	return actor.userId;
}

async function readInstance(ports: InstanceAdminPorts, host: string): Promise<InstanceAdminSnapshot> {
	const instance = await ports.read(toPuny(host));
	if (instance === null) {
		throw new Error('instance not found');
	}
	return instance;
}

export function createInstanceAdmin(ports: InstanceAdminPorts) {
	return {
		async updateInstance(access: AccessRequest, input: unknown): Promise<void> {
			const actorId = await authorize(ports, access);
			const ps = readUpdate(input);
			const instance = await readInstance(ports, ps.host);
			const changed = ps.isSuspended !== undefined && (instance.suspensionState !== 'none') !== ps.isSuspended;
			await ports.update(instance.id, {
				suspensionState: changed ? (ps.isSuspended ? 'manuallySuspended' : 'none') : undefined,
				moderationNote: ps.moderationNote,
			});
			const info = { id: instance.id, host: instance.host };
			if (changed) {
				ports.startAudit({ actorId, type: ps.isSuspended ? 'suspendRemoteInstance' : 'unsuspendRemoteInstance', info, occurredAtMs: ports.clock() });
			}
			if (ps.moderationNote !== undefined && ps.moderationNote !== instance.moderationNote) {
				ports.startAudit({ actorId, type: 'updateRemoteInstanceNote', info: { ...info, before: instance.moderationNote, after: ps.moderationNote }, occurredAtMs: ports.clock() });
			}
		},
		async refreshMetadata(access: AccessRequest, input: unknown): Promise<void> {
			await authorize(ports, access);
			const ps = readRefresh(input);
			ports.startMetadata(await readInstance(ports, ps.host));
		},
	};
}
