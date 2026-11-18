/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { upstreamRelease } from '../config/upstream-release.js';
import { createNodeInfoApi } from '../http/nodeinfo-api.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createNodeInfoHttp(resources: Pick<RuntimeResources, 'meta' | 'noteCharts' | 'federationKeys' | 'logger'>, config: Pick<RuntimeConfig, 'url'>) {
	return createNodeInfoApi({
		selfUrl: config.url,
		softwareVersion: upstreamRelease.version,
		clock: Date.now,
		federationEnabled: async () => (await resources.meta.fetch()).federation !== 'none',
		readNotes: async () => {
			const chart = await resources.noteCharts.read('notes', 'hour', 1, null, null) as { local: { total: number[] } };
			return chart.local.total[0];
		},
		readUsers: async () => {
			const chart = await resources.noteCharts.users.read('hour', 1, null) as { local: { total: number[] } };
			return chart.local.total[0];
		},
		readSettings: () => resources.meta.fetch(true),
		readProxyAccountName: async () => (await resources.federationKeys.ensureSystemAccount('proxy')).username,
		logger: resources.logger,
	});
}
