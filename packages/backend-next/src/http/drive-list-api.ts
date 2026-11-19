/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { createDriveListUsage } from '../modules/drive/list-usage.js';
import type { ApiEndpoint } from './api-endpoint.js';
export function createDriveListEndpoints(application: ReturnType<typeof createDriveListUsage>): ApiEndpoint[] {
	return ([['usage', 'drive'], ['files', 'drive/files'], ['stream', 'drive/stream'], ['folders', 'drive/folders'], ['adminFiles', 'admin/drive/files']] as const).map(([operation, name]) => ({
		name,
		access: { requireCredential: true, ...(operation === 'adminFiles' ? { requireModerator: true, kind: 'read:admin:drive' } : { kind: 'read:drive' }) },
		handle: (access, input) => application[operation](access, input, Date.now()),
	}));
}
