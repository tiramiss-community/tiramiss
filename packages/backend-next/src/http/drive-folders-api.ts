/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DriveFolderError } from '../modules/drive/folders.js';
import type { createDriveFolders } from '../modules/drive/folders.js';
import type { ApiEndpoint } from './api-endpoint.js';
export function createDriveFolderEndpoints(application: ReturnType<typeof createDriveFolders>): ApiEndpoint[] {
	return (['create', 'delete', 'find', 'show', 'update'] as const).map(operation => ({
		name: `drive/folders/${operation}`,
		access: { requireCredential: true, kind: ['find', 'show'].includes(operation) ? 'read:drive' : 'write:drive' },
		handle: (access, input) => application[operation](access, input, Date.now()),
		errors: error => error instanceof DriveFolderError ? { message: error.message, code: error.code, id: error.id, ...(error.info ? { info: error.info } : {}), ...(error.code === 'RATE_LIMIT_EXCEEDED' ? { status: 429 } : {}) } : undefined,
	}));
}
