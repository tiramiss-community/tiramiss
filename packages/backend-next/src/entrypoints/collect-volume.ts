/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { statfs, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseVolumeObservation } from '../platform/work-capacity-observation.js';

// Run on the PostgreSQL host with its actual data-volume mount, never an application-host substitute.
const [volumePath, volumeId, output] = process.argv.slice(2);
if (!volumePath || !volumeId || !output) {
	throw new Error('Usage: collect-volume <postgres-volume-path> <volume-id> <output.json>');
}
const stats = await statfs(volumePath, { bigint: true });
const now = Date.now();
const observation = parseVolumeObservation({ volumeId, observedAtMs: now,
	totalBytes: (stats.blocks * stats.bsize).toString(), freeBytes: (stats.bavail * stats.bsize).toString(),
}, volumeId, now);
const temporary = `${output}.${randomUUID()}.tmp`;
await writeFile(temporary, JSON.stringify(observation), { mode: 0o640, flag: 'wx' });
await rename(temporary, output);
