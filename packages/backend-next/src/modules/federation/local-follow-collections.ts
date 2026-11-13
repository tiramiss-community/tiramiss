/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { apContext } from './ap-context.js';

export type FollowCollectionDirection = 'followers' | 'following';

export interface FollowCollectionReader {
	readLocalUser(id: string): Promise<{ id: string; followersCount: number; followingCount: number } | null>;
	readVisibility(id: string, direction: FollowCollectionDirection): Promise<string>;
	readRelations(id: string, direction: FollowCollectionDirection, cursor?: string): Promise<{ id: string; memberId: string }[]>;
	readMember(id: string): Promise<{ id: string; host: string | null; uri: string | null }>;
}

export interface FollowCollectionResult {
	collection: Record<string, unknown>;
}

export class FollowCollectionNotFoundError extends Error {
	override readonly name = 'FollowCollectionNotFoundError';
}

export class FollowCollectionPrivateError extends Error {
	override readonly name = 'FollowCollectionPrivateError';
}

export function followCollectionIsPublic(visibility: string): boolean {
	return visibility !== 'private' && visibility !== 'followers';
}

export function renderFollowMember(user: { id: string; host: string | null; uri: string | null }, selfUrl: string): string | null {
	return user.host === null ? `${selfUrl}/users/${user.id}` : user.uri;
}

export function renderFollowCollection(partOf: string, totalItems: number, page?: { cursor?: string; items: (string | null)[]; nextCursor?: string }): Record<string, unknown> {
	if (!page) {
		return { '@context': apContext, id: partOf, type: 'OrderedCollection', totalItems, first: `${partOf}?page=true` };
	}
	// Source query() uses encodeURIComponent, preserving an explicit empty cursor and encoding spaces as %20.
	const pageUrl = (cursor?: string) => `${partOf}?page=true${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
	return {
		'@context': apContext, id: pageUrl(page.cursor), partOf, type: 'OrderedCollectionPage', totalItems, orderedItems: page.items,
		...(page.nextCursor === undefined ? {} : { next: pageUrl(page.nextCursor) }),
	};
}

export async function readFollowCollection(id: string, direction: FollowCollectionDirection, page: boolean, cursor: string | undefined, reader: FollowCollectionReader, selfUrl: string): Promise<FollowCollectionResult> {
	const user = await reader.readLocalUser(id);
	if (user === null) {
		throw new FollowCollectionNotFoundError();
	}
	const visibility = await reader.readVisibility(user.id, direction);
	if (!followCollectionIsPublic(visibility)) {
		throw new FollowCollectionPrivateError();
	}
	const partOf = `${selfUrl}/users/${id}/${direction}`;
	const count = direction === 'followers' ? user.followersCount : user.followingCount;
	if (!page) {
		return { collection: renderFollowCollection(partOf, count) };
	}
	const rows = await reader.readRelations(user.id, direction, cursor);
	const hasNext = rows.length === 11;
	const retained = hasNext ? rows.slice(0, 10) : rows;
	// Do not join/filter members: mandatory per-user reads must fail on a vanished reference, like findOneByOrFail.
	const items = await Promise.all(retained.map(async row => renderFollowMember(await reader.readMember(row.memberId), selfUrl)));
	return { collection: renderFollowCollection(partOf, count, { cursor, items, nextCursor: hasNext ? retained.at(-1)!.id : undefined }) };
}
