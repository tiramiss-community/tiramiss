/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { QUEUE_OPERATIONS } from '../modules/queue/public.js';
import type { createQueueAdmin, QueueOperation } from '../modules/queue/public.js';
import type { ApiEndpoint } from './api-endpoint.js';

// 本家の各endpoint metaは全てrequireModerator。kindは読み取り8件・操作6件に分かれる。
const writeOperations: ReadonlySet<QueueOperation> = new Set(['clear', 'promote-jobs', 'pause', 'resume', 'retry-job', 'remove-job']);

export function createQueueEndpoints(admin: ReturnType<typeof createQueueAdmin>): ApiEndpoint[] {
	return QUEUE_OPERATIONS.map(operation => ({
		name: `admin/queue/${operation}`,
		access: { requireCredential: true, requireModerator: true, kind: writeOperations.has(operation) ? 'write:admin:queue' : 'read:admin:queue' },
		handle: (access, input) => admin.execute(access, operation, input, Date.now()),
	}));
}
