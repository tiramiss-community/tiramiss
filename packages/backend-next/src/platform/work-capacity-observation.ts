/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface VolumeObservation {
	volumeId: string;
	observedAtMs: number;
	totalBytes: string;
	freeBytes: string;
}

export function parseVolumeObservation(input: unknown, volumeId: string, now: number): VolumeObservation {
	const value = input as VolumeObservation | null;
	const bytes = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v)
		&& BigInt(v) <= 9223372036854775807n;
	if (!value || value.volumeId !== volumeId || typeof volumeId !== 'string' || !volumeId || Buffer.byteLength(volumeId) > 128
		|| !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0 || value.observedAtMs > now
		|| !bytes(value.totalBytes) || !bytes(value.freeBytes) || BigInt(value.totalBytes) === 0n
		|| BigInt(value.freeBytes) > BigInt(value.totalBytes)) {
		throw new Error('Invalid PostgreSQL volume observation');
	}
	return { volumeId, observedAtMs: value.observedAtMs, totalBytes: value.totalBytes, freeBytes: value.freeBytes };
}

export function volumeAllowsWrites(value: VolumeObservation | null, now: number): boolean {
	return value !== null && now >= value.observedAtMs && now - value.observedAtMs < 120000
		&& BigInt(value.freeBytes) >= 2n * 1024n ** 3n && BigInt(value.freeBytes) * 10n >= BigInt(value.totalBytes);
}
