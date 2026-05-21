/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { MiNote } from '@/models/Note.js';
import type { MiUser, MiLocalUser } from '@/models/User.js';
import { NotificationService } from '@/core/NotificationService.js';
import { bindThis } from '@/decorators.js';

type NotificationType = 'reply' | 'renote' | 'quote' | 'mention';

class NoteNotificationManager {
	private queue: Map<MiLocalUser['id'], { target: MiLocalUser['id']; reason: NotificationType }> = new Map();

	constructor(
		private notificationService: NotificationService,
		private notifier: { id: MiUser['id'] },
		private note: MiNote,
	) {}

	@bindThis
	public push(notifiee: MiLocalUser['id'], reason: NotificationType) {
		if (this.notifier.id === notifiee) return;

		const exist = this.queue.get(notifiee);
		if (exist) {
			if (reason !== 'mention') {
				exist.reason = reason;
			}
		} else {
			this.queue.set(notifiee, { reason, target: notifiee });
		}
	}

	@bindThis
	public async notify() {
		if (this.queue.size === 0) return;

		let visibleUserIds: Set<MiUser['id']> | null;

		switch (this.note.visibility) {
			case 'public':
			case 'home':
				visibleUserIds = null;
				break;
			case 'specified':
				visibleUserIds = new Set(this.note.visibleUserIds);
				break;
			case 'followers':
				// フォロワー限定ノートにフォロワーではない人がメンションされた場合は通知される（フィルタしない）
				visibleUserIds = null;
				break;
			default:
				visibleUserIds = new Set();
				break;
		}

		for (const x of this.queue.values()) {
			const isVisibleToTarget = visibleUserIds === null || visibleUserIds.has(x.target);
			if (!isVisibleToTarget) continue;

			if (x.reason === 'renote') {
				this.notificationService.createNotification(x.target, 'renote', {
					noteId: this.note.id,
					targetNoteId: this.note.renoteId!,
				}, this.notifier.id);
			} else {
				this.notificationService.createNotification(x.target, x.reason, {
					noteId: this.note.id,
				}, this.notifier.id);
			}
		}
	}
}

@Injectable()
export class NoteNotificationManagerService {
	constructor(
		private notificationService: NotificationService,
	) {}

	@bindThis
	public create(notifier: { id: MiUser['id'] }, note: MiNote): NoteNotificationManager {
		return new NoteNotificationManager(this.notificationService, notifier, note);
	}
}
