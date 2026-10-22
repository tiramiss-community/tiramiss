/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type WorkQueue = 'deliver' | 'postLocal';

export interface DispatchReservation {
	workId: string;
	kind: string;
	schemaVersion: number;
	dispatchSeq: string;
	queueKey: WorkQueue;
	queueGeneration: string;
	token: string;
	reservedAtMs: number;
	tokenExpiresAtMs: number;
}

export interface DispatchTransport {
	enqueue(reservation: DispatchReservation, dbNowMs: number): Promise<void>;
	retire(reservation: DispatchReservation): Promise<boolean>;
}

export function dispatchJobId(reservation: DispatchReservation): string {
	return `${Buffer.from(reservation.workId).toString('base64url')}-${reservation.dispatchSeq}`;
}
