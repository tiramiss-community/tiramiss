/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createQueueApi } from '../http/queue-api.js';
import { createQueueAdmin } from '../modules/queue/public.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { appendQueueAudit, createQueueActorReader } from '../platform/database/queue-admin.js';
import { DiagnosticError } from '../platform/diagnostic-error.js';
import { createIdCodec } from '../platform/id-codec.js';
import { openQueueAdministration } from '../platform/job-queue/administration.js';
import { openQueueStats } from '../platform/queue-stats.js';
import type { RuntimeConfig } from '../config/types.js';
import type { RuntimeResources } from './create-runtime.js';

export async function openQueueHttp(resources: RuntimeResources, config: RuntimeConfig, reportFailure: (error: Error) => void) {
	const codec = createIdCodec(config.id);
	let lost: Error | undefined;
	const options = {
		redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs, logger: resources.logger,
		onLost(queue: string) {
			lost = new DiagnosticError('QUEUE_ADMIN_REDIS_ENDED', { queue });
			reportFailure(lost);
		}
	};
	const queues = await openQueueAdministration(options);
	try {
		const stats = await openQueueStats({ ...options, counts: queues.counts });
		const admin = createQueueAdmin({
			queues, readActor: createQueueActorReader(resources.dataSource.manager, codec.createdAtFromId),
			appendAudit: record => appendQueueAudit(resources.dataSource.manager, record, codec.newId),
			onError: (error, operation) => resources.logger.error('queue-admin.detached-failed', { operation, error }),
		});
		let closing: Promise<void> | undefined;
		const close = () => closing ??= (async () => {
			await stats.close();
			await admin.idle();
			await queues.close();
		})();
		if (lost) {
			await close();
			throw lost;
		}
		return { api: createQueueApi({ authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), admin, logger: resources.logger }), stats, close };
	} catch (error) {
		await queues.close();
		throw error;
	}
}
