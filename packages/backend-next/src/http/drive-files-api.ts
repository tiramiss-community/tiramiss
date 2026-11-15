/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DriveFileError } from '../modules/drive/files.js';
import type { createDriveFiles } from '../modules/drive/files.js';
import type { ApiEndpoint } from './api-endpoint.js';
export function createDriveFileEndpoints(application: ReturnType<typeof createDriveFiles>): ApiEndpoint[] {
	return ([['show', 'drive/files/show'], ['find', 'drive/files/find'], ['findByHash', 'drive/files/find-by-hash'], ['checkExistence', 'drive/files/check-existence'], ['adminShow', 'admin/drive/show-file']] as const).map(([operation, name]) => ({
		name,
		access: { requireCredential: true, ...(operation === 'adminShow' ? { requireModerator: true, kind: 'read:admin:drive' } : { kind: 'read:drive' }) },
		handle: (access, input) => application[operation](access, input, Date.now()),
		errors: error => error instanceof DriveFileError ? { message: error.message, code: error.code, id: error.id } : undefined,
	}));
}
