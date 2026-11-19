/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { planPagination } from '../shared/pagination.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { PaginationInput, PaginationPlan } from '../shared/pagination.js';
import type { PublicEmoji } from './public.js';

export interface AdminEmoji extends PublicEmoji {
	updatedAt: Date | null;
	uri: string | null;
	type: string | null;
}
export interface EmojiQuery {
	updatedAtFrom?: string; updatedAtTo?: string;
	name?: string; host?: string; uri?: string; publicUrl?: string; originalUrl?: string;
	type?: string; aliases?: string; category?: string; license?: string;
	isSensitive?: boolean; localOnly?: boolean;
	hostType?: 'all' | 'local' | 'remote'; roleIds?: string[];
}
export interface EmojiListInput extends PaginationInput {
	query: string | null; host?: string | null; limit: number;
}
export interface EmojiV2Input extends PaginationInput {
	query?: EmojiQuery | null; limit: number; page?: number; sortKeys: string[];
}
export const emojiSortKeys = ['id', 'updatedAt', 'name', 'host', 'uri', 'publicUrl', 'type', 'aliases', 'category', 'license', 'isSensitive', 'localOnly', 'roleIdsThatCanBeUsedThisEmojiAsReaction'].flatMap(key => [`+${key}`, `-${key}`]);
const cursors = {
	sinceId: { type: 'string', format: 'misskey:id' }, untilId: { type: 'string', format: 'misskey:id' },
	sinceDate: { type: 'integer' }, untilDate: { type: 'integer' },
};
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 10 };
const queryText = { type: 'string', nullable: true, default: null };
const localInput = compileInput<EmojiListInput>({ type: 'object', properties: { query: queryText, limit, ...cursors }, required: [] });
const remoteInput = compileInput<EmojiListInput>({ type: 'object', properties: { query: queryText, host: queryText, limit, ...cursors }, required: [] });
const v2Input = compileInput<EmojiV2Input>({ type: 'object', properties: {
	query: { type: 'object', nullable: true, properties: {
		...Object.fromEntries(['updatedAtFrom', 'updatedAtTo', 'name', 'host', 'uri', 'publicUrl', 'originalUrl', 'type', 'aliases', 'category', 'license'].map(key => [key, { type: 'string' }])),
		isSensitive: { type: 'boolean' }, localOnly: { type: 'boolean' },
		hostType: { type: 'string', enum: ['local', 'remote', 'all'], default: 'all' },
		roleIds: { type: 'array', items: { type: 'string', format: 'misskey:id' } },
	} },
	...cursors, limit, page: { type: 'integer' }, sortKeys: { type: 'array', default: ['-id'], items: { type: 'string', enum: emojiSortKeys } },
}, required: [] });

export class EmojiPolicyDenied extends Error {
	constructor() {
		super('You are not assigned to a required role.');
	}
}
export interface EmojiAdminPorts {
	readActor(id: string, atMs: number): Promise<AccessFacts & { canManageCustomEmojis: boolean }>;
	list(input: EmojiListInput, page: PaginationPlan, remote: boolean): Promise<AdminEmoji[]>;
	listV2(input: EmojiV2Input, bounds: { sinceId?: string; untilId?: string }): Promise<{ emojis: AdminEmoji[]; count: number; allCount: number; allPages: number }>;
	roles(ids: string[]): Promise<{ id: string; name: string; displayOrder: number }[]>;
	idFromDate(date: number): string;
}

function detailed(row: AdminEmoji) {
	return { id: row.id, aliases: row.aliases, name: row.name, category: row.category, host: row.host,
		url: row.publicUrl || row.originalUrl, license: row.license, isSensitive: row.isSensitive, localOnly: row.localOnly,
		roleIdsThatCanBeUsedThisEmojiAsReaction: row.roleIdsThatCanBeUsedThisEmojiAsReaction };
}

export function createEmojiAdmin(ports: EmojiAdminPorts) {
	async function authorize(access: AccessRequest, atMs: number) {
		const actor = requireCredential(access.credential);
		const facts = await ports.readActor(actor.userId, atMs);
		if (facts.isSuspended) {
			access.authorize(facts);
		}
		if (!facts.isAdministrator && !facts.canManageCustomEmojis) {
			throw new EmojiPolicyDenied();
		}
		access.authorize(facts);
	}

	return {
		async list(access: AccessRequest, raw: unknown, atMs: number, remote = false) {
			await authorize(access, atMs);
			const input = (remote ? remoteInput : localInput)(raw);
			return (await ports.list(input, planPagination(input, ports.idFromDate), remote)).map(detailed);
		},
		async listV2(access: AccessRequest, raw: unknown, atMs: number) {
			await authorize(access, atMs);
			const input = v2Input(raw);
			// V2 resolves each date independently even when the opposite ID is present.
			const result = await ports.listV2(input, {
				sinceId: input.sinceId ?? (input.sinceDate ? ports.idFromDate(input.sinceDate) : undefined),
				untilId: input.untilId ?? (input.untilDate ? ports.idFromDate(input.untilDate) : undefined),
			});
			const roleIds = [...new Set(result.emojis.flatMap(row => row.roleIdsThatCanBeUsedThisEmojiAsReaction))];
			const roles = new Map((roleIds.length ? await ports.roles(roleIds) : []).map(role => [role.id, role]));
			return { ...result, emojis: result.emojis.map(row => ({
				id: row.id, updatedAt: row.updatedAt?.toISOString() ?? null, name: row.name, host: row.host,
				uri: row.uri, type: row.type, aliases: row.aliases, category: row.category,
				publicUrl: row.publicUrl, originalUrl: row.originalUrl, license: row.license,
				localOnly: row.localOnly, isSensitive: row.isSensitive,
				roleIdsThatCanBeUsedThisEmojiAsReaction: row.roleIdsThatCanBeUsedThisEmojiAsReaction
					.filter(id => roles.has(id)).map(id => roles.get(id)!)
					.sort((a, b) => b.displayOrder - a.displayOrder || a.id.localeCompare(b.id))
					.map(role => ({ id: role.id, name: role.name })),
			})) };
		},
	};
}
