/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { PostWorkRequest } from '../../modules/post-work/public.js';

export interface LocalExecutionEnvelope {
	workId: string;
	kind: string;
	schemaVersion: number;
	dispatchSeq: string;
	queueGeneration: string;
}

export interface LocalExecutionClaim {
	workId: string;
	requestId: string;
	noteId: string;
	kind: 'ap.expand' | 'ap.expand.page' | 'notification.create';
	owner: string;
	epoch: string;
	attempt: number;
	deadlineAtMs: number;
	request: PostWorkRequest;
	payload: Record<string, unknown>;
}

export type LocalWorkOutcome =
	| { status: 'succeeded'; resultRef?: string }
	| { status: 'skipped' | 'cancelled' | 'failed_permanent' | 'retry'; reason: string };

export class LostLocalExecution extends Error {
	constructor() {
		super('The local execution ownership, lease or eligibility was lost');
	}
}
