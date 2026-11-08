/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import { QUEUE_NAMES } from '../../modules/queue/public.js';
import { baseQueueOptions } from './connection.js';
import { classifyHandoffJob, HANDOFF_STATES } from './handoff-policy.js';
import type { RedisConfig } from '../../config/types.js';
import type { HandoffBlocker, HandoffQueueReport, HandoffReason, HandoffState, QueueHandoffReport } from './handoff-policy.js';

export type { QueueHandoffReport } from './handoff-policy.js';

function add(blockers: HandoffBlocker[], code: HandoffReason, count = 1) {
	if (count === 0) {
		return;
	}
	const found = blockers.find(item => item.code === code);
	if (found) {
		found.count += count;
	} else {
		blockers.push({ code, count });
	}
}

function globLiteral(value: string): string {
	return value.replace(/[\\*?\[\]]/g, '\\$&');
}

async function* keys(client: Redis, prefix: string) {
	let cursor = '0';
	do {
		const page = await client.scan(cursor, 'MATCH', `${globLiteral(prefix)}*`, 'COUNT', 200);
		cursor = page[0];
		for (const key of page[1]) {
			if (key.startsWith(prefix)) {
				yield key;
			}
		}
	} while (cursor !== '0');
}

async function checkType(client: Redis, key: string, expected: string, blockers: HandoffBlocker[]): Promise<void> {
	const type = await client.type(key);
	if (type !== 'none' && type !== expected) {
		add(blockers, 'UNKNOWN_RECORD');
	}
}

async function inspectQueue(client: Redis, root: string, queue: HandoffQueueReport['queue']): Promise<HandoffQueueReport> {
	const report: HandoffQueueReport = { queue, counts: { wait: 0, paused: 0, active: 0, delayed: 0, prioritized: 0, 'waiting-children': 0, completed: 0, failed: 0, repeat: 0 }, paused: (await client.hexists(`${root}:meta`, 'paused')) === 1, blockers: [] };
	const indexed = new Map<string, HandoffState>();
	for (const state of HANDOFF_STATES) {
		const list = ['wait', 'paused', 'active'].includes(state);
		report.counts[state] = list ? await client.llen(`${root}:${state}`) : await client.zcard(`${root}:${state}`);
		for (let start = 0; start < report.counts[state]; start += 200) {
			const ids = list ? await client.lrange(`${root}:${state}`, start, start + 199) : await client.zrange(`${root}:${state}`, start, start + 199);
			for (const id of ids) {
				if (indexed.has(id)) {
					add(report.blockers, 'UNKNOWN_RECORD');
				}
				indexed.set(id, state);
				const raw = await client.hgetall(`${root}:${id}`);
				if (!raw.name || !raw.data) {
					add(report.blockers, 'UNKNOWN_RECORD');
				}
				const reason = classifyHandoffJob(queue, state, raw);
				if (reason) {
					add(report.blockers, reason);
				}
			}
		}
	}
	report.counts.repeat = await client.zcard(`${root}:repeat`);
	add(report.blockers, 'SCHEDULER', report.counts.repeat);
	add(report.blockers, 'STALLED', await client.scard(`${root}:stalled`));
	const metadata = new Set([...HANDOFF_STATES, 'repeat', 'stalled', 'stalled-check', 'id', 'meta', 'events', 'pc', 'marker', 'limiter']);
	const metadataTypes: Record<string, string> = { marker: 'zset', events: 'stream', meta: 'hash', id: 'string', pc: 'string', 'stalled-check': 'string', limiter: 'string' };
	const scanned = new Set<string>();
	for await (const key of keys(client, `${root}:`)) {
		// SCAN may repeat a key even without concurrent writes.
		if (scanned.has(key)) {
			continue;
		}
		scanned.add(key);
		const suffix = key.slice(root.length + 1);
		if (metadata.has(suffix)) {
			if (metadataTypes[suffix]) {
				await checkType(client, key, metadataTypes[suffix], report.blockers);
			}
			continue;
		}
		if (suffix.endsWith(':lock')) {
			add(report.blockers, 'LOCK');
		} else if (suffix.startsWith('repeat:')) {
			add(report.blockers, 'SCHEDULER');
		} else if (suffix.endsWith(':dependencies') || suffix.endsWith(':processed') || suffix.endsWith(':failed') || suffix.endsWith(':unsuccessful')) {
			add(report.blockers, 'DEPENDENCY');
		} else if (indexed.has(suffix)) {
			continue;
		} else if (suffix.endsWith(':logs') && indexed.has(suffix.slice(0, -5))) {
			await checkType(client, key, 'list', report.blockers);
			continue;
		} else if (/^metrics:(completed|failed)(:data)?$/.test(suffix)) {
			await checkType(client, key, suffix.endsWith(':data') ? 'list' : 'hash', report.blockers);
			continue;
		} else {
			add(report.blockers, 'UNKNOWN_RECORD');
		}
	}
	return report;
}

/** Read-only census; the caller must first stop every producer, scheduler and consumer. */
export async function inspectQueueHandoff(options: { redis: RedisConfig; connectTimeoutMs: number }): Promise<QueueHandoffReport> {
	const { connection } = baseQueueOptions(options.redis, 'deliver', options.connectTimeoutMs);
	const client = new Redis({ ...connection, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: options.connectTimeoutMs });
	// The CLI prints fixed codes only; Redis errors can contain credentials or keys.
	client.on('error', () => {});
	try {
		await client.connect();
		const report: QueueHandoffReport = { ready: true, queues: [], blockers: [] };
		const namespace = options.redis.prefix ? `${options.redis.prefix}:queue:` : 'queue:';
		const roots = QUEUE_NAMES.map(name => `${baseQueueOptions(options.redis, name, options.connectTimeoutMs).prefix}:${name}`);
		const scanned = new Set<string>();
		for await (const key of keys(client, namespace)) {
			if (!scanned.has(key) && !roots.some(root => key.startsWith(`${root}:`))) {
				add(report.blockers, 'UNKNOWN_QUEUE');
			}
			scanned.add(key);
		}
		for (const [index, name] of QUEUE_NAMES.entries()) {
			report.queues.push(await inspectQueue(client, roots[index], name));
		}
		report.ready = report.blockers.length === 0 && report.queues.every(queue => queue.blockers.length === 0);
		return report;
	} catch {
		throw new Error('QUEUE_HANDOFF_INSPECTION_FAILED');
	} finally {
		client.disconnect();
	}
}
