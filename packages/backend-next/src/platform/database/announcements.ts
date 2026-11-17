/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Brackets, In } from 'typeorm';
import { MiAnnouncement, MiAnnouncementRead, MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { AnnouncementPorts } from '../../modules/announcement/public.js';

export function createAnnouncementStore(manager: EntityManager): Pick<AnnouncementPorts, 'list' | 'find' | 'readIds' | 'readActor' | 'insertRead' | 'deactivate' | 'hasUnread'> {
	const announcements = manager.getRepository(MiAnnouncement);
	const reads = manager.getRepository(MiAnnouncementRead);
	const target = (viewerId: string | null) => new Brackets(query => {
		query.where('announcement.userId IS NULL');
		if (viewerId) {
			query.orWhere('announcement.userId = :viewerId', { viewerId });
		}
	});
	const active = (now: Date) => new Brackets(query => {
		query.where('announcement.autoArchiveAt IS NULL').orWhere('announcement.autoArchiveAt > :now', { now });
	});
	return {
		async list(viewerId, isActive, now, page, limit) {
			const query = announcements.createQueryBuilder('announcement').where(target(viewerId));
			if (isActive) {
				query.andWhere('announcement.isActive = true').andWhere(active(now));
			} else {
				query.andWhere(new Brackets(q => q.where('announcement.isActive = false').orWhere('announcement.autoArchiveAt <= :now', { now })));
			}
			if (page.sinceId) {
				query.andWhere('announcement.id > :sinceId', { sinceId: page.sinceId });
			}
			if (page.untilId) {
				query.andWhere('announcement.id < :untilId', { untilId: page.untilId });
			}
			return query.orderBy('announcement.id', page.order).limit(limit).getMany();
		},
		find: id => announcements.findOneBy({ id }),
		async readIds(viewerId, ids) {
			const rows = await reads.find({ where: { userId: viewerId, announcementId: In(ids) }, select: { announcementId: true } });
			return new Set(rows.map(row => row.announcementId));
		},
		async readActor(id) {
			const user = await manager.getRepository(MiUser).findOneByOrFail({ id });
			return { isSuspended: user.isSuspended, isModerator: false, isAdministrator: false };
		},
		async insertRead(id, userId, announcementId) {
			await reads.insert({ id, userId, announcementId });
		},
		async deactivate(id) {
			await announcements.update(id, { isActive: false });
		},
		async hasUnread(viewerId, now) {
			const subquery = reads.createQueryBuilder('read').select('read.announcementId').where('read.userId = :viewerId', { viewerId });
			return announcements.createQueryBuilder('announcement')
				.where('announcement.isActive = true').andWhere(active(now)).andWhere('announcement.silence = false')
				.andWhere(target(viewerId))
				.andWhere(new Brackets(query => query.where('announcement.forExistingUsers = false').orWhere('announcement.id > :viewerId', { viewerId })))
				.andWhere(`announcement.id NOT IN (${subquery.getQuery()})`).setParameters(subquery.getParameters()).getExists();
		},
	};
}
