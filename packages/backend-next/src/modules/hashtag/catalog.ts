/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput } from '../access/public.js';
import { normalizeHashtag } from './public.js';

export interface HashtagCounts {
	name: string;
	mentionedUsersCount: number;
	mentionedLocalUsersCount: number;
	mentionedRemoteUsersCount: number;
	attachedUsersCount: number;
	attachedLocalUsersCount: number;
	attachedRemoteUsersCount: number;
}
export const hashtagSorts = ['+mentionedUsers', '-mentionedUsers', '+mentionedLocalUsers', '-mentionedLocalUsers', '+mentionedRemoteUsers', '-mentionedRemoteUsers', '+attachedUsers', '-attachedUsers', '+attachedLocalUsers', '-attachedLocalUsers', '+attachedRemoteUsers', '-attachedRemoteUsers'] as const;
export interface HashtagListInput {
	limit: number;
	attachedToUserOnly: boolean;
	attachedToLocalUserOnly: boolean;
	attachedToRemoteUserOnly: boolean;
	sort: typeof hashtagSorts[number];
}
export interface HashtagSearchInput { query: string; limit: number; offset: number }
export interface HashtagCatalogReader {
	list(input: HashtagListInput): Promise<HashtagCounts[]>;
	search(input: HashtagSearchInput): Promise<string[]>;
	find(name: string): Promise<HashtagCounts | null>;
}
export class HashtagMissing extends Error {
	readonly code = 'NO_SUCH_HASHTAG';
	readonly id = '110ee688-193e-4a3a-9ecf-c167b2e6981e';
	constructor() {
		super('No such hashtag.');
	}
}
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 10 };
const listInput = compileInput<HashtagListInput>({ type: 'object', properties: {
	limit,
	attachedToUserOnly: { type: 'boolean', default: false },
	attachedToLocalUserOnly: { type: 'boolean', default: false },
	attachedToRemoteUserOnly: { type: 'boolean', default: false },
	sort: { type: 'string', enum: hashtagSorts },
}, required: ['sort'] });
const searchInput = compileInput<HashtagSearchInput>({ type: 'object', properties: {
	limit, query: { type: 'string' }, offset: { type: 'integer', default: 0 },
}, required: ['query'] });
const showInput = compileInput<{ tag: string }>({ type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] });

export function renderHashtag(row: HashtagCounts) {
	return {
		tag: row.name,
		mentionedUsersCount: row.mentionedUsersCount,
		mentionedLocalUsersCount: row.mentionedLocalUsersCount,
		mentionedRemoteUsersCount: row.mentionedRemoteUsersCount,
		attachedUsersCount: row.attachedUsersCount,
		attachedLocalUsersCount: row.attachedLocalUsersCount,
		attachedRemoteUsersCount: row.attachedRemoteUsersCount,
	};
}
export function createHashtagCatalog(reader: HashtagCatalogReader) {
	return {
		async list(raw: unknown) {
			return (await reader.list(listInput(raw))).map(renderHashtag);
		},
		async search(raw: unknown) {
			const input = searchInput(raw);
			return reader.search({ ...input, query: input.query.toLowerCase() });
		},
		async show(raw: unknown) {
			const row = await reader.find(normalizeHashtag(showInput(raw).tag));
			if (!row) {
				throw new HashtagMissing();
			}
			return renderHashtag(row);
		},
	};
}
