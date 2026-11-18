/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { setTimeout } from 'node:timers/promises';
import { validateResetInput, validateTestInput } from '../modules/test-controls/public.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { assertTestResetTarget, resetTestDatabase } from '../platform/database/reset-test-storage.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createTestControlsHttp(resources: Pick<RuntimeResources, 'dataSource' | 'redis' | 'meta' | 'logger' | 'publishInternalEvent'>, config: RuntimeConfig) {
	return createApiEndpoints({
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		logger: resources.logger,
		endpoints: [{
			name: 'test', access: { requireCredential: false },
			handle: async (_access, input) => validateTestInput(input),
		}, {
			name: 'reset-db', access: { requireCredential: false },
			handle: async (_access, input) => {
				validateResetInput(input);
				assertTestResetTarget(config, process.env);
				await resources.redis.flushdb();
				await resetTestDatabase(resources.dataSource);
				const meta = await resources.meta.fetch(true);
				try {
					await resources.publishInternalEvent('metaUpdated', { after: meta });
				} catch {
					try {
						resources.logger.error('reset-db.publish-failed');
					} catch { /* Diagnostics cannot turn a committed reset into a failure. */ }
				}
				await setTimeout(1000);
			},
		}],
	});
}
