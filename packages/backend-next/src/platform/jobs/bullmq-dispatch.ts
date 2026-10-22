/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Queue, QueueKeys, RedisConnection, RedisQueueBackend } from 'bullmq';
import { createRequire } from 'node:module';
import type { BackendFactory, RawCommand, RedisOptions } from 'bullmq';

const require = createRequire(import.meta.url);
if (require('bullmq/package.json').version !== '6.3.11') {
	throw new Error('Review the dispatch Lua fence before upgrading BullMQ');
}
const scripts: Record<string, RawCommand> = require('bullmq/dist/cjs/scripts/index.js');
import { dispatchJobId } from './dispatch.js';
import type { DispatchReservation, DispatchTransport, WorkQueue } from './dispatch.js';

// Checking before queue.add would let a delayed producer cross token retirement.
// Keep the installed, pinned BullMQ insertion script inside the same Redis operation.
const fence = `
local envelope = cjson.decode(ARGV[2])
local reservation = envelope.reservation
local args = cmsgpack.unpack(ARGV[1])
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
if math.abs(now - envelope.dbNowMs) > 5000 then return redis.error_reply('dispatch clock skew') end
if now >= reservation.tokenExpiresAtMs then return redis.error_reply('dispatch token expired') end
if redis.call('GET', KEYS[3] .. ':dispatch-generation') ~= reservation.queueGeneration then
  return redis.error_reply('dispatch generation mismatch')
end
local tokenKey = KEYS[3] .. ':dispatch-token:' .. args[2]
local value = redis.call('GET', tokenKey)
if value == 'retired' then return redis.error_reply('dispatch token retired') end
if value and value ~= reservation.token then return redis.error_reply('dispatch token mismatch') end
redis.call('SET', tokenKey, reservation.token, 'PXAT', reservation.tokenExpiresAtMs)
ARGV[2] = cjson.encode(envelope.data)
`;

class FencedConnection extends RedisConnection {
	protected override loadCommands(version: string): void {
		super.loadCommands(version, {
			...scripts,
			addStandardJob: { ...scripts.addStandardJob, content: fence + scripts.addStandardJob.content },
			dispatchInitialize: { name: 'dispatchInitialize', keys: 1, content: `
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then return redis.error_reply('dispatch generation mismatch') end
redis.call('SET', KEYS[1], ARGV[1])
return 1` },
			dispatchReplaceGeneration: { name: 'dispatchReplaceGeneration', keys: 1, content: `
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]
if (current or '') ~= expected then return redis.error_reply('dispatch generation changed') end
redis.call('SET', KEYS[1], ARGV[2])
return 1` },
			dispatchRetire: { name: 'dispatchRetire', keys: 1, content: retireToken },
		});
	}
}

const fencedBackend = (prefix: string): BackendFactory<RedisQueueBackend> => (name, options, mode) => {
	if (mode?.blocking || mode?.withBlockingConnection) {
		throw new Error('Dispatch connections cannot consume jobs');
	}
	const keys = new QueueKeys(prefix);
	return new RedisQueueBackend(new FencedConnection(options.connection), name, keys.getKeys(name), type => keys.toKey(name, type), options);
};

const retireToken = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
if now < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], 'retired', 'PXAT', ARGV[1])
end
return 1
`;

export class BullmqDispatch implements DispatchTransport {
	private readonly queues: Record<WorkQueue, Queue>;

	constructor(connection: RedisOptions, prefix: string) {
		if (connection.keyPrefix) {
			throw new Error('BullMQ requires its own prefix, without Redis keyPrefix');
		}
		this.queues = Object.fromEntries((['deliver', 'postLocal'] as const).map(name => [name,
			new Queue(name, { connection: { ...connection }, prefix }, fencedBackend(prefix)),
		])) as Record<WorkQueue, Queue>;
	}

	async initialize(queueKey: WorkQueue, generation: string): Promise<void> {
		if (!/^[1-9][0-9]*$/.test(generation)) {
			throw new Error('Invalid dispatch generation');
		}
		const queue = this.queues[queueKey];
		const client = await queue.backend.client;
		const key = `${queue.keys.meta}:dispatch-generation`;
		await queue.backend.execCommand(client, 'dispatchInitialize', [key, generation]);
	}

	async readGeneration(queueKey: WorkQueue): Promise<string | null> {
		const queue = this.queues[queueKey];
		return (await queue.backend.client).get(`${queue.keys.meta}:dispatch-generation`);
	}

	// Startup coordinator only: the DB recovery fence must already be committed.
	async replaceGeneration(queueKey: WorkQueue, expected: string | null, generation: string): Promise<void> {
		const valid = (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
		if (!valid(generation) || (expected !== null && (!valid(expected) || BigInt(expected) > BigInt(generation)))) {
			throw new Error('Invalid dispatch generation');
		}
		const queue = this.queues[queueKey];
		const client = await queue.backend.client;
		await queue.backend.execCommand(client, 'dispatchReplaceGeneration', [
			`${queue.keys.meta}:dispatch-generation`, expected ?? '', generation,
		]);
	}

	async enqueue(reservation: DispatchReservation, dbNowMs: number): Promise<void> {
		if (!Number.isSafeInteger(dbNowMs) || !Number.isSafeInteger(reservation.reservedAtMs) ||
			reservation.tokenExpiresAtMs !== reservation.reservedAtMs + 60000 ||
			!/^[1-9][0-9]*$/.test(reservation.dispatchSeq) || !/^[1-9][0-9]*$/.test(reservation.queueGeneration) ||
			!reservation.token || Buffer.byteLength(reservation.token) > 128 ||
			!reservation.workId || Buffer.byteLength(reservation.workId) > 128) {
			throw new Error('Invalid dispatch reservation');
		}
		const { workId, kind, schemaVersion, dispatchSeq, queueGeneration } = reservation;
		await this.queues[reservation.queueKey].add('post-work', {
			reservation, dbNowMs, data: { workId, kind, schemaVersion, dispatchSeq, queueGeneration },
		}, {
			jobId: dispatchJobId(reservation), attempts: 1,
			removeOnComplete: { age: 7 * 86400, count: 30 }, removeOnFail: { age: 7 * 86400, count: 100 },
		});
	}

	async retire(reservation: DispatchReservation): Promise<boolean> {
		const queue = this.queues[reservation.queueKey];
		const client = await queue.backend.client;
		const id = dispatchJobId(reservation);
		await queue.backend.execCommand(client, 'dispatchRetire', [`${queue.keys.meta}:dispatch-token:${id}`, String(reservation.tokenExpiresAtMs)]);
		const job = await queue.getJob(id);
		if (!job) {
			return true;
		}
		const state = await job.getState();
		if (state === 'active') {
			return false;
		}
		if (state === 'completed' || state === 'failed') {
			return true;
		}
		try {
			await job.remove();
		} catch {
			// A worker may acquire the job after getState; retain the reservation.
			return false;
		}
		return true;
	}

	async close(): Promise<void> {
		await Promise.all(Object.values(this.queues).map(queue => queue.close()));
	}
}
