/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createQueueWorkers } from '../../../src/composition/queue-workers.js';
import { testConfig } from '../../helpers/database.js';
import type { RuntimeResources } from '../../../src/composition/create-runtime.js';

test('building the static table does not construct handlers or open workers', () => {
	const failure = new Error('handler constructed');
	const resources = {
		logger: {},
		get dataSource() {
			throw failure;
		},
	} as unknown as RuntimeResources;
	const workers = createQueueWorkers(resources, testConfig(), () => {});
	expect(workers.map(worker => worker.name)).toEqual(['endedPollNotification', 'userWebhookDeliver', 'deliver']);
});
