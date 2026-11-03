/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRuntime, type RuntimeResources } from '../composition/create-runtime.js';
import { assertMigrationsApplied } from '../platform/database/check-migrations.js';
import { ResourceScope } from '../platform/resource-scope.js';
import type { RuntimeConfig } from '../config/types.js';

export interface RunningProcess {
	failure?: Promise<Error>;
	stop(): Promise<void>;
}

export async function startManagedProcess(
	role: 'http' | 'worker',
	config: RuntimeConfig,
	// reportFailure は起動後に役割固有の接続・処理を失ったときに呼ぶ。共有の接続の喪失は resources が報告する。
	start: (resources: RuntimeResources, reportFailure: (error: Error) => void) => Promise<() => Promise<void>>,
): Promise<RunningProcess> {
	const resources = await createRuntime(config, role);
	const scope = new ResourceScope();
	scope.defer(resources.close);
	let reportFailure!: (error: Error) => void;
	const roleFailure = new Promise<Error>(resolve => {
		reportFailure = resolve;
	});

	try {
		await assertMigrationsApplied(config.database);
		scope.defer(await start(resources, reportFailure));
		return { stop: () => scope.close(), failure: Promise.race([resources.failure, roleFailure]) };
	} catch (error) {
		try {
			await scope.close();
		} catch (cleanupError) {
			resources.logger.error('cleanup.failed', { error: cleanupError });
		}

		throw error;
	}
}
