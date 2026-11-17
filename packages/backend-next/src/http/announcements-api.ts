/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AnnouncementMissing } from '../modules/announcement/public.js';
import type { createAnnouncements } from '../modules/announcement/public.js';
import type { ApiEndpoint } from './api-endpoint.js';

export function createAnnouncementEndpoints(application: ReturnType<typeof createAnnouncements>): ApiEndpoint[] {
	return [
		{ name: 'announcements', access: { requireCredential: false }, handle: (access, input) => application.list(access, input) },
		{ name: 'announcements/show', access: { requireCredential: false }, handle: (access, input) => application.show(access, input),
			errors: error => error instanceof AnnouncementMissing ? { message: error.message, code: error.code, id: error.id } : undefined },
		{ name: 'i/read-announcement', access: { requireCredential: true, kind: 'write:account' }, handle: (access, input) => application.read(access, input) },
	];
}
