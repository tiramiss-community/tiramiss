/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { parseVolumeObservation } from '../../work-capacity-observation.js';
import type { DataSource } from 'typeorm';

export async function recordVolumeObservation(source: DataSource, input: unknown, volumeId: string): Promise<void> {
	const [{ now }] = await source.query('SELECT clock_timestamp() AS now') as { now: Date }[];
	const observation = parseVolumeObservation(input, volumeId, now.getTime());
	await source.createQueryBuilder().update('backend_internal.work_capacity').set({
		physical_volume_id: observation.volumeId, physical_observed_at: new Date(observation.observedAtMs),
		physical_free_bytes: observation.freeBytes, physical_total_bytes: observation.totalBytes,
	}).where("capacity_key='global'")
		.andWhere('(physical_observed_at IS NULL OR physical_observed_at < :observedAt)', { observedAt: new Date(observation.observedAtMs) })
		.execute();
}
