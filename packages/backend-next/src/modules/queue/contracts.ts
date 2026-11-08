/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export const QUEUE_NAMES = ['system', 'endedPollNotification', 'postScheduledNote', 'deliver', 'inbox', 'db', 'relationship', 'objectStorage', 'userWebhookDeliver', 'systemWebhookDeliver'] as const;
export type QueueName = typeof QUEUE_NAMES[number];
export const QUEUE_OPERATIONS = ['clear', 'deliver-delayed', 'inbox-delayed', 'retry-job', 'remove-job', 'show-job', 'show-job-logs', 'promote-jobs', 'pause', 'resume', 'jobs', 'stats', 'queues', 'queue-stats'] as const;
export type QueueOperation = typeof QUEUE_OPERATIONS[number];
export type QueueState = 'active' | 'wait' | 'delayed' | 'completed' | 'failed';
export type ClearState = QueueState | 'paused' | 'prioritized' | '*';
export interface QueueJob {
	id?: string; name: string; data: unknown; opts: unknown; timestamp: number;
	processedOn?: number; processedBy?: string; finishedOn?: number; progress: unknown;
	attemptsMade: number; delay: number; failedReason?: string; stacktrace?: readonly unknown[] | null; returnvalue: unknown;
}
export type QueueCounts = Record<string, number>;
export interface QueueOverview {
	name: QueueName; counts: QueueCounts; isPaused: boolean;
	metrics: { completed: unknown; failed: unknown };
}
export interface QueueAdministration {
	job(queue: QueueName, id: string): Promise<QueueJob | null>;
	jobs(queue: QueueName, states: readonly QueueState[], end?: number): Promise<QueueJob[]>;
	logs(queue: QueueName, id: string): Promise<string[]>;
	counts(queue: QueueName): Promise<QueueCounts>;
	overview(queue: QueueName): Promise<QueueOverview>;
	backend(queue: QueueName): Promise<{ qualifiedName: string; info: string }>;
	clear(queue: QueueName, state: ClearState): Promise<void>;
	promoteJobs(queue: QueueName): Promise<void>;
	pause(queue: QueueName): Promise<void>;
	resume(queue: QueueName): Promise<void>;
	retryJob(queue: QueueName, id: string): Promise<void>;
	removeJob(queue: QueueName, id: string): Promise<void>;
}
export interface QueueAudit { actorId: string; type: 'clearQueue' | 'promoteQueue' | 'pauseQueue' | 'resumeQueue'; occurredAtMs: number }
export interface QueueStatsSample {
	deliver: { activeSincePrevTick: number; active: number; waiting: number; delayed: number };
	inbox: { activeSincePrevTick: number; active: number; waiting: number; delayed: number };
}
export interface QueueStatsReader {
	subscribe(listener: (sample: QueueStatsSample) => void): () => void;
	readLog(length: number): QueueStatsSample[];
}
