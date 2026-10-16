/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Container } from 'inversify';
import { connectResources } from '../platform/connect-resources.js';
import { createLogger } from '../platform/logger.js';
import type { RuntimeConfig } from '../config/types.js';
export type RuntimeResources = Awaited<ReturnType<typeof connectResources>>;
export async function createRuntime(
	config: RuntimeConfig,
	role: 'http' | 'worker' = 'http',
): Promise<RuntimeResources> {
	const container = new Container();
	container.bind('logger').toConstantValue(createLogger(role));
	return connectResources(config, container.get('logger'));
}
