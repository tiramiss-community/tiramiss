/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRuntime, type RuntimeResources } from '../composition/create-runtime.js';
import { assertMigrationsApplied } from '../platform/database/check-migrations.js';
import { ResourceScope } from '../platform/resource-scope.js';
import type { RuntimeConfig } from '../config/types.js';

export interface RunningProcess {
	stop(): Promise<void>;
}

export async function startManagedProcess(
	role: 'http' | 'worker',
	config: RuntimeConfig,
	start: (resources: RuntimeResources) => Promise<() => Promise<void>>,
): Promise<RunningProcess> {
	const resources = await createRuntime(config, role);
	const scope = new ResourceScope();
	scope.defer(resources.close);

	try {
		await assertMigrationsApplied(config.database);
		scope.defer(await start(resources));
		return { stop: () => scope.close() };
	} catch (error) {
		try {
			await scope.close();
		} catch (cleanupError) {
			resources.logger.error('cleanup.failed', { error: cleanupError });
		}

		throw error;
	}
}
