/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../../src/config/types.js';
export function testConfig(): RuntimeConfig {
	const redis = {
		host: '127.0.0.1',
		port: Number(process.env.BACKEND_NEXT_TEST_REDIS_PORT ?? 56379),
		db: 0,
		prefix: 'backend-next-test',
		keyPrefix: 'backend-next-test:',
	};
	return {
		url: 'http://example.test',
		id: 'aidx',
		roleCache: { rolesTtlMs: 30000, assignmentsTtlMs: 30000, assignmentsMaxEntries: 10000 },
		database: {
			host: '127.0.0.1',
			port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55432),
			database: 'backend_next_test',
			username: 'postgres',
			password: 'foundation-test-only',
			extra: {},
		},
		redis,
		redisForJobQueue: redis,
		redisForPubsub: redis,
		http: { port: 0 },
		processes: { workerCount: 1, startupTimeoutMs: 10000, shutdownTimeoutMs: 1000 },
	};
}
export async function createTestDatabase() {
	const config = testConfig();
	const name = `backend_next_${randomUUID().replaceAll('-', '')}`;
	const admin = new DataSource({ type: 'postgres', ...config.database });
	await admin.initialize();
	await admin.query(`CREATE DATABASE "${name}"`);
	config.database.database = name;
	return {
		config,
		async close() {
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.destroy();
		},
	};
}

export async function migrateTestDatabase(config: RuntimeConfig['database']): Promise<void> {
	const { migrateDatabase } = await import('../../src/platform/database/migrate.js');
	const { createDataSource } = await import('../../src/platform/database/data-source.js');
	const { recordVolumeObservation } = await import('../../src/platform/database/work-capacity/observation.js');
	await migrateDatabase(config);
	const source = await createDataSource(config).initialize();
	try {
		await recordVolumeObservation(source, { volumeId: 'dedicated-test-volume', observedAtMs: Date.now(),
			totalBytes: '21474836480', freeBytes: '10737418240' }, 'dedicated-test-volume');
	} finally {
		await source.destroy();
	}
}

export async function seedHealthyCapacity(source: DataSource): Promise<void> {
	await source.createQueryBuilder().update('backend_internal.work_capacity').set({
		physical_observed_at: () => 'clock_timestamp()', physical_free_bytes: '10737418240',
		physical_total_bytes: '21474836480', physical_volume_id: 'dedicated-test-volume',
	}).where("capacity_key='global'").execute();
}
