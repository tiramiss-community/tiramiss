/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { planPagination } from '../shared/pagination.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { PaginationInput, PaginationPlan } from '../shared/pagination.js';

export interface AnnouncementRow {
	id: string;
	updatedAt: Date | null;
	title: string;
	text: string;
	imageUrl: string | null;
	icon: string;
	display: string;
	needConfirmationToRead: boolean;
	silence: boolean;
	userId: string | null;
}
export interface AnnouncementPorts {
	list(viewerId: string | null, active: boolean, now: Date, page: PaginationPlan, limit: number): Promise<AnnouncementRow[]>;
	find(id: string): Promise<AnnouncementRow | null>;
	readIds(viewerId: string, ids: string[]): Promise<Set<string>>;
	readActor(id: string): Promise<AccessFacts>;
	insertRead(id: string, viewerId: string, announcementId: string): Promise<void>;
	deactivate(id: string): Promise<void>;
	hasUnread(viewerId: string, now: Date): Promise<boolean>;
	readAll(viewerId: string): void;
	newId(): string;
	idFromDate(date: number): string;
	createdAtFromId(id: string): number;
	now(): Date;
}
export class AnnouncementMissing extends Error {
	readonly code = 'NO_SUCH_ANNOUNCEMENT';
	readonly id = 'b57b5e1d-4f49-404a-9edb-46b00268f121';
	constructor() {
		super('No such announcement.');
	}
}
const listInput = compileInput<PaginationInput & { limit: number; isActive: boolean }>({
	type: 'object', properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' }, untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' }, untilDate: { type: 'integer' }, isActive: { type: 'boolean', default: true },
	}, required: [],
});
const idInput = compileInput<{ announcementId: string }>({
	type: 'object', properties: { announcementId: { type: 'string', format: 'misskey:id' } }, required: ['announcementId'],
});

export function renderAnnouncement(row: AnnouncementRow, viewerId: string | null, isRead: boolean | undefined, createdAt: number) {
	return {
		id: row.id, createdAt: new Date(createdAt).toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null,
		title: row.title, text: row.text, imageUrl: row.imageUrl, icon: row.icon, display: row.display,
		forYou: row.userId === viewerId && viewerId !== null,
		needConfirmationToRead: row.needConfirmationToRead, silence: row.silence, ...(isRead === undefined ? {} : { isRead }),
	};
}

export function createAnnouncements(ports: AnnouncementPorts) {
	const pack = (row: AnnouncementRow, viewerId: string | null, reads: Set<string>) => renderAnnouncement(
		row, viewerId, viewerId ? reads.has(row.id) : undefined, ports.createdAtFromId(row.id),
	);
	return {
		async list(access: AccessRequest, raw: unknown) {
			const input = listInput(raw);
			const viewerId = access.credential?.userId ?? null;
			const page = planPagination(input, ports.idFromDate);
			const rows = await ports.list(viewerId, input.isActive, ports.now(), page, input.limit);
			let reads = new Set<string>();
			if (viewerId && rows.length) {
				try {
					reads = await ports.readIds(viewerId, rows.map(row => row.id));
				} catch {
					// The pinned packMany omits every item whose read lookup fails.
					return [];
				}
			}
			const results = await Promise.allSettled(rows.map(async row => pack(row, viewerId, reads)));
			return results.filter(result => result.status === 'fulfilled').map(result => result.value);
		},
		async show(access: AccessRequest, raw: unknown) {
			const { announcementId } = idInput(raw);
			const viewerId = access.credential?.userId ?? null;
			const row = await ports.find(announcementId);
			if (row === null || (row.userId !== null && row.userId !== viewerId)) {
				throw new AnnouncementMissing();
			}
			const reads = viewerId ? await ports.readIds(viewerId, [row.id]) : new Set<string>();
			return pack(row, viewerId, reads);
		},
		async read(access: AccessRequest, raw: unknown): Promise<void> {
			const actor = requireCredential(access.credential);
			access.authorize(await ports.readActor(actor.userId));
			const { announcementId } = idInput(raw);
			try {
				await ports.insertRead(ports.newId(), actor.userId, announcementId);
			} catch {
				// Upstream treats every insertion failure, including duplicates and missing FK targets, as a no-op.
				return;
			}
			const row = await ports.find(announcementId);
			if (row?.userId === actor.userId) {
				await ports.deactivate(announcementId);
			}
			if (!await ports.hasUnread(actor.userId, ports.now())) {
				ports.readAll(actor.userId);
			}
		},
	};
}
