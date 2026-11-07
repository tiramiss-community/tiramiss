/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { AuthenticationFailed, CredentialRequired } from '../../../src/http/authentication-error.js';
import { testConfig } from '../../helpers/database.js';
import { createQueueAdmin } from '../../../src/modules/queue/admin.js';
import { createQueueApi } from '../../../src/http/queue-api.js';
import { openQueueAdministration } from '../../../src/platform/job-queue/administration.js';
import type { QueueOperation } from '../../../src/modules/queue/public.js';

const state = vi.hoisted(() => ({ current: null as any }));
vi.mock('bullmq', async original => {
	const real = await original<typeof import('bullmq')>();
	const { EventEmitter: Emitter } = await import('node:events');
	class Queue extends Emitter {
		qualifiedName: string;
		constructor(readonly name: string) {
			super();
			this.qualifiedName = `fixture:queue:${name}:${name}`;
		}
		waitUntilReady() {
			return Promise.resolve();
		}
		close() {
			return Promise.resolve();
		}
		getBackend() {
			return { client: Promise.resolve(Object.assign(new Emitter(), { status: 'ready', info: () => state.current.operation(this.name, 'info', [], state.current.info) })) };
		}
		getJob(id: string) {
			return state.current.operation(this.name, 'getJob', [id], state.current.jobs(this.name).find((job: any) => job.id === id));
		}
		getJobs(types: string[], start = 0, end = -1) {
			return state.current.operation(this.name, 'getJobs', [types, start, end], state.current.jobs(this.name).slice(start, end < 0 ? undefined : end + 1));
		}
		getJobLogs(id: string) {
			return state.current.operation(this.name, 'getJobLogs', [id], { logs: state.current.options.logs ?? ['log: fixture-secret'], count: 1 });
		}
		getJobCounts() {
			return state.current.operation(this.name, 'getJobCounts', [], state.current.options.counts ?? state.current.counts);
		}
		isPaused() {
			return state.current.operation(this.name, 'isPaused', [], false);
		}
		getMetrics(...args: unknown[]) {
			return state.current.operation(this.name, 'getMetrics', args, state.current.metric);
		}
		clean(...args: unknown[]) {
			return state.current.operation(this.name, 'clean', args, []);
		}
		promoteJobs() {
			return state.current.operation(this.name, 'promoteJobs', []);
		}
		pause() {
			return state.current.operation(this.name, 'pause', []);
		}
		resume() {
			return state.current.operation(this.name, 'resume', []);
		}
	}
	return { ...real, Queue };
});

const corpus = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/queue-admin/observations.json', import.meta.url), 'utf8')) as { observations: { id: string; layer: string; input: any; expected: any }[] };
const clone = (value: unknown) => value === undefined ? null : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const actor = { userId: 'actor', canReadQueue: true, canWriteQueue: true };

async function setup(input: any) {
	const options = input.doubles ?? {};
	const calls: any[] = [];
	const errors: string[] = [];
	let release!: () => void;
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	const fixture = {
		options, calls,
		counts: { active: 1, waiting: 2, delayed: 3, completed: 4, failed: 5, paused: 0, prioritized: 0, 'waiting-children': 0 },
		metric: { meta: { count: 4, prevTS: 1000, prevCount: 3 }, data: [1, 2], count: 2 },
		info: '# Server\nredis_version:7.2.0\nredis_mode:standalone\nrun_id:fixture-run\nprocess_id:123\ntcp_port:6379\nos:Linux\nuptime_in_seconds:10\ntotal_system_memory:0\nmaxmemory:1234\nused_memory:200\nmem_fragmentation_ratio:1.75\nused_memory_peak:300\nconnected_clients:4\nblocked_clients:1\n',
		operation(queue: string, method: string, args: unknown[], result?: unknown) {
			calls.push({ queue, method, args: clone(args) });
			if (options.fail === method) {
				return Promise.reject(new Error(`fixture ${method} failed`));
			}
			return input.heldQueueOperation === method ? held.then(() => result) : Promise.resolve(result);
		},
		jobs(queue: string) {
			const jobs = input.repeatedJobs ? Array.from({ length: input.repeatedJobs.count }, (_, i) => ({ id: String(i), ...input.repeatedJobs })) : options.jobs ?? [{ id: 'job', name: 'test job', data: { content: 'body-visible', to: 'https://remote.example/inbox', signature: { keyId: 'https://signer.example/key' }, secret: 'fixture-secret', userId: 'recipient-visible' }, finishedOn: 1000 }];
			return jobs.map((data: any) => ({
				timestamp: 100, processedOn: 200, processedBy: 'worker', progress: 0, attemptsMade: 2, delay: 10, stacktrace: ['older', '', null, 'newer'], opts: { attempts: 12 }, returnvalue: { result: true }, ...data,
				retry: () => fixture.operation(queue, 'retry', [data.id]), promote: () => fixture.operation(queue, 'promote', [data.id]), remove: () => fixture.operation(queue, 'remove', [data.id]),
			}));
		},
	};
	state.current = fixture;
	const registry = await openQueueAdministration({ redis: testConfig().redisForJobQueue, connectTimeoutMs: 1000, logger: { info() { }, error() { } }, onLost() { } });
	const name = input.actor ?? 'moderator';
	const admin = createQueueAdmin({
		queues: registry, readActor: async () => ({ isSuspended: name.includes('suspended'), isModerator: name !== 'member' }), appendAudit: async (record: any) => {
			calls.push({ method: 'moderation.insert', value: { id: 'audit-id', userId: record.actorId, type: record.type, info: {} } });
			if (options.fail === 'audit') {
				throw new Error('fixture audit failed');
			}
		}, onError: (error: unknown) => {
			errors.push((error as Error).message);
		}
	});
	const app = createQueueApi({
		admin, logger: { info() { }, error() { } }, authenticate: async () => {
			if (name === 'anonymous') {
				throw new CredentialRequired();
			}
			if (name === 'invalid-token') {
				throw new AuthenticationFailed();
			}
			return { ...actor, userId: name === 'root' || name === 'root-suspended' ? 'root' : 'actor', canReadQueue: name !== 'wrong-scope', canWriteQueue: !['wrong-scope', 'read-only-scope'].includes(name) };
		}
	});
	return {
		app, admin, calls, errors, release, close: async () => {
			release(); await admin.idle(); await registry.close();
		}
	};
}

test.each(corpus.observations.filter((o: any) => o.layer === 'http-handler'))('fixed-source $id response and external effects', async (observation: any) => {
	const s = await setup(observation.input);
	try {
		const response = await s.app.request(`/api/${observation.input.route}`, { method: 'POST', body: JSON.stringify(observation.input.params), headers: { 'Content-Type': 'application/json' } });
		const body = response.status === 204 ? null : await response.json();
		if (body?.error?.info?.e?.id) {
			body.error.info.e.id = '00000000-0000-4000-8000-000000000001';
		}
		const challenge = response.headers.get('WWW-Authenticate');
		expect({ status: response.status, headers: challenge ? { 'WWW-Authenticate': challenge } : {}, body }).toEqual(observation.expected.response);
		expect(s.calls.length).toBe(observation.expected.callsAtResponse);
		await s.admin.idle();
		expect(s.calls).toEqual(observation.expected.calls);
		expect(s.errors).toEqual(observation.expected.detachedRejections);
	} finally {
		await s.close();
	}
});

test.each(corpus.observations.filter((o: any) => o.id.startsWith('boundary-')))('fixed-source $id await/detach boundary', async (observation: any) => {
	const s = await setup(observation.input);
	let settled = false;
	const pending = s.admin.execute(actor, observation.input.route.split('/').at(-1) as QueueOperation, observation.input.params, 1000).then(() => {
		settled = true;
	});
	try {
		await turn();
		expect({ settled, calls: s.calls }).toEqual(observation.expected.beforeRelease);
		s.release(); await pending; await s.admin.idle();
		expect({ settled, calls: s.calls }).toEqual(observation.expected.afterRelease);
	} finally {
		await s.close();
	}
});

test.each(corpus.observations.filter((o: any) => o.input.repeatedJobs))('fixed-source $id full JSON digest', async (observation: any) => {
	const s = await setup(observation.input);
	try {
		const result = await s.admin.execute(actor, 'jobs', observation.input.params, 1000) as unknown[];
		expect({ count: result.length, first: clone(result[0]), last: clone(result.at(-1)), digest: createHash('sha256').update(JSON.stringify(result)).digest('hex'), calls: s.calls }).toEqual(observation.expected);
	} finally {
		await s.close();
	}
});
