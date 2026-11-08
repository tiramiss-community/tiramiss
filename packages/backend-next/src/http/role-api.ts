/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRequestEvaluation, RoleNotFound, type RoleEvaluation, type RoleShowData } from '../modules/role/public.js';
import { roleResponse } from './role-response.js';
import type { AccessRequest } from '../modules/access/public.js';
import type { ApiEndpoint } from './api-endpoint.js';
import type { ApiErrorBody } from './api-error.js';

function noSuchRole(id: string) {
	return (error: unknown): ApiErrorBody | undefined => error instanceof RoleNotFound ? { message: 'No such role.', code: 'NO_SUCH_ROLE', id } : undefined;
}

async function withEvaluation<T>(work: (evaluation: RoleEvaluation) => Promise<T>): Promise<T> {
	const evaluation = createRequestEvaluation(Date.now);
	try {
		return await work(evaluation);
	} finally {
		evaluation.close();
	}
}

export function createRoleEndpoints(dependencies: {
	showRole(access: AccessRequest, input: unknown, evaluation: RoleEvaluation): Promise<RoleShowData>;
	updateRole(access: AccessRequest, input: unknown, evaluation: RoleEvaluation): Promise<void>;
}): ApiEndpoint[] {
	return [
		{
			name: 'admin/roles/show',
			access: { requireCredential: true, requireModerator: true, kind: 'read:admin:roles' },
			handle: (access, input) => withEvaluation(async evaluation => roleResponse(await dependencies.showRole(access, input, evaluation))),
			errors: noSuchRole('07dc7d34-c0d8-49b7-96c6-db3ce64ee0b3'),
		},
		{
			name: 'admin/roles/update',
			access: { requireCredential: true, requireAdmin: true, kind: 'write:admin:roles' },
			handle: (access, input) => withEvaluation(evaluation => dependencies.updateRole(access, input, evaluation)),
			errors: noSuchRole('cd23ef55-09ad-428a-ac61-95a45e124b32'),
		},
	];
}
