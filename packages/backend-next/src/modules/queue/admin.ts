/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { ActorNotFound, ActorSuspended, CredentialScopeDenied, ModeratorRequired } from '../role/public.js';
import { QUEUE_NAMES } from './contracts.js';
import { readQueueInput } from './input.js';
import type { ClearState, QueueActor, QueueAdministration, QueueAudit, QueueJob, QueueName, QueueOperation, QueueState } from './contracts.js';

function pack(queue: QueueName, job: QueueJob) {
	let data = job.data;
	if ((queue === 'userWebhookDeliver' || queue === 'systemWebhookDeliver') && typeof data === 'object' && data !== null && 'secret' in data) {
		data = { ...data, secret: '(redacted)' };
	}
	const stacktrace = job.stacktrace ? job.stacktrace.filter(Boolean).reverse() : [];
	return {
		id: job.id, name: job.name, data, opts: job.opts, timestamp: job.timestamp, processedOn: job.processedOn,
		processedBy: job.processedBy, finishedOn: job.finishedOn, progress: job.progress, attempts: job.attemptsMade,
		delay: job.delay, failedReason: job.failedReason, stacktrace, returnValue: job.returnvalue, isFailed: !!job.failedReason || stacktrace.length > 0
	};
}

function redisInfo(info: string) {
	const db = Object.fromEntries(info.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.trim().split(':').slice(0, 2)));
	return {
		version: db.redis_version, mode: db.redis_mode, runId: db.run_id, processId: db.process_id,
		port: parseInt(db.tcp_port), os: db.os, uptime: parseInt(db.uptime_in_seconds),
		memory: { total: parseInt(db.total_system_memory) || parseInt(db.maxmemory), used: parseInt(db.used_memory), fragmentationRatio: parseInt(db.mem_fragmentation_ratio), peak: parseInt(db.used_memory_peak) },
		clients: { connected: parseInt(db.connected_clients), blocked: parseInt(db.blocked_clients) }
	};
}

export function createQueueAdmin(ports: {
	queues: QueueAdministration;
	readActor(userId: string, now: number): Promise<{ isSuspended: boolean; isModerator: boolean } | null>;
	appendAudit(record: QueueAudit): Promise<void>;
	onError(error: unknown, operation: string): void;
}) {
	const pending = new Set<Promise<unknown>>();
	// Preserve upstream's detached acknowledgments, but diagnose rejections and drain started work on shutdown.
	const detached = (work: Promise<unknown>, operation: string) => {
		const task = work.catch(error => ports.onError(error, operation));
		pending.add(task);
		void task.then(() => pending.delete(task), () => pending.delete(task));
	};
	return {
		async idle(): Promise<void> {
			while (pending.size) {
				await Promise.allSettled([...pending]);
			}
		},
		async execute(actor: QueueActor, operation: QueueOperation, rawInput: unknown, now: number): Promise<unknown> {
			const facts = await ports.readActor(actor.userId, now);
			if (!facts) {
				throw new ActorNotFound();
			}
			if (facts.isSuspended) {
				throw new ActorSuspended();
			}
			if (!facts.isModerator) {
				throw new ModeratorRequired();
			}
			const write = ['clear', 'promote-jobs', 'pause', 'resume', 'retry-job', 'remove-job'].includes(operation);
			if (!(write ? actor.canWriteQueue : actor.canReadQueue)) {
				throw new CredentialScopeDenied();
			}
			const input = readQueueInput(operation, rawInput);
			const { queues } = ports;
			const audit = (type: QueueAudit['type']) => detached(ports.appendAudit({ actorId: actor.userId, type, occurredAtMs: now }), 'audit');
			switch (operation) {
				case 'clear':
					detached(queues.clear(input.queue, input.state as ClearState), operation);
					audit('clearQueue');
					return;
				case 'promote-jobs':
					detached(queues.promoteJobs(input.queue), operation);
					audit('promoteQueue');
					return;
				case 'retry-job':
					detached(queues.retryJob(input.queue, input.jobId), operation);
					return;
				case 'remove-job':
					detached(queues.removeJob(input.queue, input.jobId), operation);
					return;
				case 'pause':
					await queues.pause(input.queue);
					audit('pauseQueue');
					return;
				case 'resume':
					await queues.resume(input.queue);
					audit('resumeQueue');
					return;
				case 'show-job': {
					const job = await queues.job(input.queue, input.jobId);
					if (!job) {
						throw new Error(`Job not found: ${input.jobId}`);
					}
					return pack(input.queue, job);
				}
				case 'show-job-logs': return queues.logs(input.queue, input.jobId);
				case 'jobs': {
					const jobs = (await queues.jobs(input.queue, input.state as QueueState[], input.search ? 1000 : 100)).map(job => pack(input.queue, job));
					if (!input.search) {
						return jobs;
					}
					const terms = input.search.toLowerCase().split(' ');
					return jobs.filter(job => {
						const text = JSON.stringify(job).toLowerCase();
						return terms.every(term => text.includes(term));
					}).slice(0, 100);
				}
				case 'queues': return Promise.all(QUEUE_NAMES.map(name => queues.overview(name)));
				case 'queue-stats': {
					const summary = await queues.overview(input.queue);
					const backend = await queues.backend(input.queue);
					return { name: summary.name, qualifiedName: backend.qualifiedName, counts: summary.counts, isPaused: summary.isPaused, metrics: summary.metrics, db: redisInfo(backend.info) };
				}
				case 'stats': return { deliver: await queues.counts('deliver'), inbox: await queues.counts('inbox'), db: await queues.counts('db'), objectStorage: await queues.counts('objectStorage') };
				case 'deliver-delayed':
				case 'inbox-delayed': {
					const jobs = await queues.jobs(operation === 'deliver-delayed' ? 'deliver' : 'inbox', ['delayed']);
					const counts = new Map<string, number>();
					for (const job of jobs) {
						const data = job.data as { to: string; signature: { keyId: string } };
						const host = new URL(operation === 'deliver-delayed' ? data.to : data.signature.keyId).host;
						counts.set(host, (counts.get(host) ?? 0) + 1);
					}
					return [...counts.entries()].sort((a, b) => b[1] - a[1]);
				}
			}
		},
	};
}
