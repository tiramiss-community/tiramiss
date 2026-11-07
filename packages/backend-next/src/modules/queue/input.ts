/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import { QUEUE_NAMES } from './contracts.js';
import type { ClearState, QueueName, QueueOperation, QueueState } from './contracts.js';

export class QueueInputInvalid extends Error {
	constructor(readonly param: string, readonly reason: string) {
		super('Invalid param.');
	}
}
const ajv = new Ajv({ useDefaults: true });
const queue = { type: 'string', enum: QUEUE_NAMES };
const jobId = { type: 'string' };
const states = ['active', 'wait', 'delayed', 'completed', 'failed'];
const schema = (properties: object, required: string[]) => ajv.compile({ type: 'object', properties, required });
const noParams = schema({}, []);
const queueOnly = schema({ queue }, ['queue']);
const withJob = schema({ queue, jobId }, ['queue', 'jobId']);
const jobs = schema({ queue, state: { type: 'array', items: { type: 'string', enum: states } }, search: { type: 'string' } }, ['queue', 'state']);
const clear = schema({ queue, state: { type: 'string', enum: ['*', 'completed', 'wait', 'active', 'paused', 'prioritized', 'delayed', 'failed'] } }, ['queue', 'state']);

export function readQueueInput(operation: QueueOperation, value: unknown) {
	const validate = ['stats', 'queues', 'deliver-delayed', 'inbox-delayed'].includes(operation) ? noParams
		: ['show-job', 'show-job-logs', 'retry-job', 'remove-job'].includes(operation) ? withJob
			: operation === 'jobs' ? jobs : operation === 'clear' ? clear : queueOnly;
	if (!validate(value)) {
		const error = validate.errors![0];
		throw new QueueInputInvalid(error.schemaPath, error.message!);
	}
	return value as { queue: QueueName; jobId: string; state: QueueState[] | ClearState; search?: string };
}
