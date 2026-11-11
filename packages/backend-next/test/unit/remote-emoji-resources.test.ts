/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EventEmitter } from 'node:events';
import { JobRuntime } from '@mokurokujs/core';
import { MiEmoji } from 'backend-upstream/entities';
import { afterEach, expect, test, vi } from 'vitest';
import { connectResources } from '../../src/platform/connect-resources.js';
import * as database from '../../src/platform/database/data-source.js';
import { createLogger } from '../../src/platform/logger.js';
import { testConfig } from '../helpers/database.js';

vi.mock('node:crypto', async importOriginal => ({
	...await importOriginal<typeof import('node:crypto')>(),
	randomInt: () => 0,
}));

vi.mock('ioredis', () => ({
	Redis: class extends EventEmitter {
		status = 'ready';
		async connect() {}
		async ping() {}
		async subscribe() {}
		disconnect() {
			this.status = 'end';
			this.emit('end');
		}
	},
}));

vi.mock('../../src/composition/outbound-http.js', () => ({
	createOutboundHttpClient: () => ({ close: async () => {} }),
}));

afterEach(() => vi.restoreAllMocks());

test('public actor emoji resources insert distinct aid IDs within one millisecond', async () => {
	const config = { ...testConfig(), id: 'aid' } as const;
	const source = database.createDataSource(config.database);
	const repository = source.getRepository(MiEmoji);
	const rows = new Map<string, MiEmoji>();
	vi.spyOn(database, 'createDataSource').mockReturnValue(source);
	vi.spyOn(source, 'initialize').mockResolvedValue(source);
	vi.spyOn(JobRuntime.prototype, 'ready').mockResolvedValue();
	vi.spyOn(JobRuntime.prototype, 'stop').mockResolvedValue();
	vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
	vi.spyOn(repository, 'findBy').mockResolvedValue([]);
	vi.spyOn(repository, 'insert').mockImplementation(async input => {
		const row = input as MiEmoji;
		if (rows.has(row.id)) {
			throw new Error('duplicate emoji primary key');
		}
		rows.set(row.id, row);
		return { identifiers: [{ id: row.id }], generatedMaps: [], raw: [] };
	});
	vi.spyOn(repository, 'findOneOrFail').mockImplementation(async options => {
		const { id } = options.where as { id: string };
		return rows.get(id)!;
	});

	const resources = await connectResources(config, createLogger('emoji-test', () => {}));
	try {
		const tag = (name: string) => ({ type: 'Emoji', name: `:${name}:`, icon: { url: `https://remote.test/${name}.png` } });
		const result = await resources.remoteEmojis.extract([tag('wave'), tag('spark')], 'remote.test');
		const later = await resources.remoteEmojis.extract([tag('star')], 'remote.test');
		expect(result.map(row => row.name)).toEqual(['wave', 'spark']);
		expect(later.map(row => row.name)).toEqual(['star']);
		expect([...rows.keys()]).toEqual(['aw09u68001', 'aw09u68002', 'aw09u68003']);
	} finally {
		await resources.close();
	}
});
