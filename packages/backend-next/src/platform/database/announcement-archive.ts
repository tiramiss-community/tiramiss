/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull, Not } from 'typeorm';
import { MiAnnouncement } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { AnnouncementArchivePorts } from '../../modules/announcement/public.js';

export function createAnnouncementArchiveStore(manager: EntityManager): Pick<AnnouncementArchivePorts, 'reservations' | 'archive'> {
	const announcements = manager.getRepository(MiAnnouncement);
	return {
		async reservations() {
			const rows = await announcements.find({ where: { isActive: true, autoArchiveAt: Not(IsNull()) }, select: { id: true, autoArchiveAt: true } });
			return rows.map(row => ({ announcementId: row.id, autoArchiveAt: row.autoArchiveAt! }));
		},
		async archive(announcementId, autoArchiveAt, now) {
			const result = await announcements.createQueryBuilder().update().set({ isActive: false, updatedAt: now })
				.where('id = :announcementId', { announcementId })
				.andWhere('isActive = true')
				.andWhere('autoArchiveAt = :autoArchiveAt', { autoArchiveAt })
				.andWhere('autoArchiveAt <= :now', { now }).execute();
			return (result.affected ?? 0) > 0;
		},
	};
}
