/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { recordVolumeObservation } from './database/work-capacity/observation.js';
import { chargedTables } from './database/work-capacity/accounting.js';
import { parseVolumeObservation, volumeAllowsWrites } from './work-capacity-observation.js';
import type { Logger } from './logger.js';
import type { DataSource } from 'typeorm';

export interface CapacityMonitorConfig { file: string; volumeId: string }

export async function pollWorkCapacity(source: DataSource, options: CapacityMonitorConfig, logger: Logger): Promise<boolean> {
	try {
		const file = await open(options.file, constants.O_RDONLY | constants.O_NONBLOCK);
		let input: unknown;
		try {
			if (!(await file.stat()).isFile()) {
				throw new Error('Volume observation must be a regular file');
			}
			const buffer = Buffer.alloc(4097);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 4096) {
				throw new Error('Volume observation exceeds 4096 bytes');
			}
			input = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
		} finally {
			await file.close();
		}
		await recordVolumeObservation(source, input, options.volumeId);
		const [usage] = await source.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
		 (SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text FROM pg_class c
		 WHERE c.relnamespace='backend_internal'::regnamespace AND c.relkind='r' AND c.relname=ANY($1::text[])) AS relation_bytes,
		 clock_timestamp() AS now, physical_volume_id, physical_observed_at, physical_free_bytes, physical_total_bytes
		 FROM backend_internal.work_capacity WHERE capacity_key='global'`, [chargedTables]);
		const observation = parseVolumeObservation({ volumeId: usage.physical_volume_id, observedAtMs: usage.physical_observed_at?.getTime(),
			totalBytes: usage.physical_total_bytes, freeBytes: usage.physical_free_bytes }, options.volumeId, usage.now.getTime());
		const accepting = volumeAllowsWrites(observation, usage.now.getTime());
		logger.info('work-capacity.observed', { ...observation, ...usage, accepting });
		return accepting;
	} catch (error) {
		// A failed read must not refresh the last successful sample; the transactional gate expires it.
		logger.error('work-capacity.monitor-failed', { error });
		return false;
	}
}

export async function startWorkCapacityMonitor(source: DataSource, options: CapacityMonitorConfig | undefined, logger: Logger) {
	if (!options) {
		logger.info('work-capacity.supplier-missing', { admission: 'closed without a fresh DB volume observation' });
		return async () => {};
	}
	await source.createQueryBuilder().update('backend_internal.work_capacity').set({
		physical_observed_at: null, physical_free_bytes: null, physical_total_bytes: null, physical_volume_id: null,
	}).where('physical_volume_id IS DISTINCT FROM :volumeId', { volumeId: options.volumeId }).execute();
	let pending = pollWorkCapacity(source, options, logger);
	await pending;
	let polling = false;
	const timer = setInterval(() => {
		if (!polling) {
			polling = true;
			pending = pollWorkCapacity(source, options, logger).finally(() => {
 polling = false; 
});
		}
	}, 60000);
	timer.unref();
	return async () => {
		clearInterval(timer);
		await pending;
	};
}
