/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface AnnouncementArchiveReservation {
	announcementId: string;
	autoArchiveAt: Date;
}

export interface AnnouncementArchivePorts {
	reservations(): Promise<AnnouncementArchiveReservation[]>;
	schedule(announcementId: string, autoArchiveAt: Date): Promise<void>;
	archive(announcementId: string, autoArchiveAt: Date, now: Date): Promise<boolean>;
	now(): Date;
}

export function createAnnouncementArchives(ports: AnnouncementArchivePorts) {
	return {
		async restore(): Promise<void> {
			const reservations = await ports.reservations();
			await Promise.all(reservations.map(row => ports.schedule(row.announcementId, row.autoArchiveAt)));
		},
		archive: (announcementId: string, autoArchiveAt: Date) => ports.archive(announcementId, autoArchiveAt, ports.now()),
	};
}
