/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { ModerationLogEntry } from '../audit/public.js';
import type { AvatarDecoration } from './public.js';

export interface AdminAvatarDecoration extends AvatarDecoration {
	updatedAt: Date | null;
}
type Attributes = Omit<AdminAvatarDecoration, 'id' | 'updatedAt'>;
export interface AvatarDecorationAdminPorts {
	readActor(userId: string, atMs: number): Promise<AccessFacts & { canManageAvatarDecorations: boolean }>;
	getAll(noCache: boolean): Promise<AdminAvatarDecoration[]>;
	insert(row: { id: string } & Partial<Attributes>): Promise<AdminAvatarDecoration>;
	find(id: string): Promise<AdminAvatarDecoration>;
	update(id: string, patch: Partial<Attributes> & { updatedAt: Date }): Promise<AdminAvatarDecoration>;
	delete(id: string): Promise<void>;
	publish(type: string, row: AdminAvatarDecoration): void;
	audit(entry: ModerationLogEntry): void;
	newId(atMs: number): string;
	createdAtFromId(id: string): number;
}
export class AvatarDecorationPolicyDenied extends Error {
	constructor() {
		super('You are not assigned to a required role.');
		this.name = 'AvatarDecorationPolicyDenied';
	}
}
const attributes = {
	name: { type: 'string', minLength: 1 }, description: { type: 'string' }, url: { type: 'string', minLength: 1 },
	roleIdsThatCanBeUsedThisDecoration: { type: 'array', items: { type: 'string' } }, category: { type: 'string', nullable: true },
};
const createInput = compileInput<Attributes>({ type: 'object', properties: attributes, required: ['name', 'description', 'url'] });
const updateInput = compileInput<{ id: string } & Partial<Attributes>>({ type: 'object', properties: { id: { type: 'string', format: 'misskey:id' }, ...attributes }, required: ['id'] });
const deleteInput = compileInput<{ id: string }>({ type: 'object', properties: { id: { type: 'string', format: 'misskey:id' } }, required: ['id'] });
const listInput = compileInput({ type: 'object', properties: {
	limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
	sinceId: { type: 'string', format: 'misskey:id' }, untilId: { type: 'string', format: 'misskey:id' },
	sinceDate: { type: 'integer' }, untilDate: { type: 'integer' }, userId: { type: 'string', format: 'misskey:id', nullable: true },
}, required: [] });

export function createAvatarDecorationAdmin(ports: AvatarDecorationAdminPorts) {
	async function authorize(access: AccessRequest, atMs: number) {
		const actor = requireCredential(access.credential);
		const facts = await ports.readActor(actor.userId, atMs);
		if (facts.isSuspended) {
			access.authorize(facts);
		}
		// ApiCallService checks requiredRolePolicy before the app scope, with root/admin bypass.
		if (!facts.isAdministrator && !facts.canManageAvatarDecorations) {
			throw new AvatarDecorationPolicyDenied();
		}
		return access.authorize(facts).userId;
	}

	function render(row: AdminAvatarDecoration) {
		return { id: row.id, createdAt: new Date(ports.createdAtFromId(row.id)).toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null,
											name: row.name, description: row.description, url: row.url, roleIdsThatCanBeUsedThisDecoration: row.roleIdsThatCanBeUsedThisDecoration, category: row.category };
	}

	function values(input: Partial<Attributes>): Partial<Attributes> {
		return Object.fromEntries(Object.keys(attributes).filter(key => Object.hasOwn(input, key)).map(key => [key, input[key as keyof Attributes]]));
	}

	return {
		async create(access: AccessRequest, input: unknown, atMs: number) {
			const actorId = await authorize(access, atMs);
			const row = await ports.insert({ id: ports.newId(atMs), ...values(createInput(input)) });
			ports.publish('avatarDecorationCreated', row);
			ports.audit({ actorId, type: 'createAvatarDecoration', occurredAtMs: atMs, info: { avatarDecorationId: row.id, avatarDecoration: row } });
			return render(row);
		},
		async update(access: AccessRequest, input: unknown, atMs: number) {
			const actorId = await authorize(access, atMs);
			const params = updateInput(input);
			const before = await ports.find(params.id);
			const after = await ports.update(before.id, { updatedAt: new Date(atMs), ...values(params) });
			ports.publish('avatarDecorationUpdated', after);
			ports.audit({ actorId, type: 'updateAvatarDecoration', occurredAtMs: atMs, info: { avatarDecorationId: before.id, before, after } });
		},
		async delete(access: AccessRequest, input: unknown, atMs: number) {
			const actorId = await authorize(access, atMs);
			const params = deleteInput(input);
			const row = await ports.find(params.id);
			await ports.delete(row.id);
			ports.publish('avatarDecorationDeleted', row);
			ports.audit({ actorId, type: 'deleteAvatarDecoration', occurredAtMs: atMs, info: { avatarDecorationId: row.id, avatarDecoration: row } });
		},
		async list(access: AccessRequest, input: unknown, atMs: number) {
			await authorize(access, atMs);
			listInput(input);
			return (await ports.getAll(true)).map(render);
		},
	};
}
