/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Job } from 'bullmq';
import { parseDeliverJob } from './deliver.js';
import { parsePollEndedJob } from './ended-poll-notification.js';
import type { QueueName } from '../../modules/queue/public.js';

export const HANDOFF_STATES = ['wait', 'paused', 'active', 'delayed', 'prioritized', 'waiting-children', 'completed', 'failed'] as const;
export type HandoffState = typeof HANDOFF_STATES[number];
export type HandoffReason = 'ACTIVE' | 'LOCK' | 'SCHEDULER' | 'DEPENDENCY' | 'UNSUPPORTED_QUEUE' | 'INVALID_PAYLOAD' | 'UNSUPPORTED_OPTIONS' | 'UNKNOWN_RECORD' | 'UNKNOWN_QUEUE' | 'STALLED';
export interface HandoffBlocker { code: HandoffReason; count: number }
export interface HandoffQueueReport {
	queue: QueueName;
	counts: Record<HandoffState | 'repeat', number>;
	paused: boolean;
	blockers: HandoffBlocker[];
}
export interface QueueHandoffReport { ready: boolean; queues: HandoffQueueReport[]; blockers: HandoffBlocker[] }

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retention(value: unknown): boolean {
	if (typeof value === 'boolean') {
		return true;
	}
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) && value >= 0;
	}
	return object(value) && Object.entries(value).every(([key, count]) => ['age', 'count'].includes(key) && typeof count === 'number' && Number.isFinite(count) && count >= 0);
}

function webhook(data: unknown): boolean {
	if (!object(data) || typeof data.type !== 'string' || !['webhookId', 'userId', 'to', 'secret', 'eventId'].every(key => typeof data[key] === 'string') || typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt) || !object(data.content)) {
		return false;
	}
	const field = ['note', 'reply', 'renote', 'mention'].includes(data.type) ? 'note'
		: ['follow', 'unfollow', 'followed'].includes(data.type) ? 'user' : null;
	return field !== null && object(data.content[field]);
}

/** Only formats exercised by the current handlers can cross the stopped boundary. */
export function classifyHandoffJob(queue: QueueName, state: HandoffState, raw: Record<string, string>): HandoffReason | null {
	if (state === 'active') {
		return 'ACTIVE';
	}
	if (state === 'waiting-children' || raw.parent || raw.parentKey) {
		return 'DEPENDENCY';
	}
	if (raw.rjk) {
		return 'SCHEDULER';
	}
	if (state === 'completed') {
		return null;
	}
	if (!['deliver', 'endedPollNotification', 'userWebhookDeliver'].includes(queue)) {
		return 'UNSUPPORTED_QUEUE';
	}
	try {
		// BullMQ eagerly decodes progress while claiming a job, before the handler.
		if (raw.progress) {
			JSON.parse(raw.progress);
		}
	} catch {
		return 'UNKNOWN_RECORD';
	}
	try {
		const data: unknown = JSON.parse(raw.data);
		if (queue === 'deliver') {
			parseDeliverJob(data);
		} else if (queue === 'endedPollNotification') {
			parsePollEndedJob(data);
		} else if (!webhook(data)) {
			return 'INVALID_PAYLOAD';
		}
	} catch {
		return 'INVALID_PAYLOAD';
	}
	try {
		if (!raw.opts || !object(JSON.parse(raw.opts))) {
			return 'UNSUPPORTED_OPTIONS';
		}
		const opts = Job.optsFromJSON(raw.opts) as Record<string, unknown>;
		if (opts.repeat || opts.repeatJobKey) {
			return 'SCHEDULER';
		}
		if (opts.parent || opts.failParentOnFailure || opts.continueParentOnFailure || opts.ignoreDependencyOnFailure || opts.removeDependencyOnFailure) {
			return 'DEPENDENCY';
		}
		const allowed = ['attempts', 'backoff', 'delay', 'priority', 'timestamp', 'jobId', 'removeOnComplete', 'removeOnFail'];
		if (Object.keys(opts).some(key => !allowed.includes(key))) {
			return 'UNSUPPORTED_OPTIONS';
		}
		if (opts.attempts !== undefined && (typeof opts.attempts !== 'number' || !Number.isSafeInteger(opts.attempts) || opts.attempts < 0)) {
			return 'UNSUPPORTED_OPTIONS';
		}
		if (opts.backoff !== undefined && (!object(opts.backoff) || opts.backoff.type !== 'custom' || Object.keys(opts.backoff).some(key => key !== 'type'))) {
			return 'UNSUPPORTED_OPTIONS';
		}
		if (queue === 'endedPollNotification' && opts.backoff !== undefined) {
			return 'UNSUPPORTED_OPTIONS';
		}
		for (const key of ['delay', 'priority', 'timestamp'] as const) {
			if (opts[key] !== undefined && (typeof opts[key] !== 'number' || !Number.isFinite(opts[key]))) {
				return 'UNSUPPORTED_OPTIONS';
			}
		}
		if (typeof opts.priority === 'number' && (!Number.isSafeInteger(opts.priority) || opts.priority < 0 || opts.priority > 2097152)) {
			return 'UNSUPPORTED_OPTIONS';
		}
		for (const key of ['removeOnComplete', 'removeOnFail']) {
			if (opts[key] !== undefined && !retention(opts[key])) {
				return 'UNSUPPORTED_OPTIONS';
			}
		}
		if (raw.defa) {
			return 'UNKNOWN_RECORD';
		}
	} catch {
		return 'UNSUPPORTED_OPTIONS';
	}
	return null;
}
