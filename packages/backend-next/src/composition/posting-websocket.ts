/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createIdCodec } from '../platform/id-codec.js';
import { createStreamingReader } from '../platform/database/streaming.js';
import { openStreamingServer } from '../platform/streaming-server.js';
import type { Server } from 'node:http';
import type { RuntimeConfig } from '../config/types.js';
import type { RuntimeResources } from './create-runtime.js';
import type { QueueStatsReader } from '../modules/queue/public.js';

export function openPostingWebSocket(server: Server, resources: RuntimeResources, config: RuntimeConfig, onFailure: (error: Error) => void, queueStats?: QueueStatsReader) {
	return openStreamingServer(server, {
		redis: { ...config.redisForPubsub, connectTimeout: config.processes.startupTimeoutMs }, selfUrl: config.url,
		ports: createStreamingReader(resources.dataSource.manager, resources.reactionsRedis, resources.logger, { ...config.noteMedia, url: config.url, createdAtFromId: createIdCodec(config.id).createdAtFromId }),
		logger: resources.logger, onFailure, queueStats,
	});
}
