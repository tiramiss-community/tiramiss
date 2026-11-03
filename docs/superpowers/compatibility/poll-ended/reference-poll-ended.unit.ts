/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { allSettled } from '@/misc/promise-tracker.js';
import { baseQueueOptions, QUEUE } from '@/queue/const.js';
import { EndedPollNotificationProcessorService } from '@/queue/processors/EndedPollNotificationProcessorService.js';
import { QueueProcessorService } from '@/queue/QueueProcessorService.js';

// 対象はre2を使わない。ネイティブモジュールを.node-versionのNodeで再ビルドせずに実行できるよう差し替える。
vi.mock('re2', () => ({ default: class {} }));

// QueueProcessorService が作る Worker の名前・設定・登録したイベント・processor を記録する。Redis へは接続しない。
const workers = vi.hoisted(() => [] as { name: string; processor: (job: unknown) => Promise<unknown>; opts: Record<string, unknown>; events: string[] }[]);
vi.mock('bullmq', async original => {
	const actual = await original<typeof import('bullmq')>();
	class RecordingWorker {
		events: string[] = [];
		constructor(public name: string, public processor: (job: unknown) => Promise<unknown>, public opts: Record<string, unknown>) {
			workers.push(this);
		}

		on(event: string) {
			this.events.push(event);
			return this;
		}
	}
	return { ...actual, Worker: RecordingWorker };
});

type Profile = { userHost: string | null; notificationRecieveConfig: Record<string, unknown> };
type ProcessorCase = {
	id: string;
	note: { userId: string; hasPoll: boolean } | null;
	votes: { userId: string; userHost: string | null }[];
	profiles: Record<string, Profile>;
	storeFailsFor?: string[];
};

const write = process.env.POLL_ENDED_PROBE_WRITE === '1';

function load<T, C>(name: string): { path: URL; inputs: T; cases: C } {
	const path = new URL(`./${name}`, import.meta.url);
	return { path, ...JSON.parse(readFileSync(path, 'utf8')) };
}

function settle(path: URL, inputs: unknown, stored: unknown, actual: unknown) {
	if (write) {
		writeFileSync(path, JSON.stringify({ inputs, cases: actual }, null, '\t') + '\n');
		return;
	}
	expect(actual).toEqual(stored);
}

// 呼ばれたメソッドを問わず、自分自身か「解決すると [] になる値」を返す。投票終了ジョブの投入に関係しない依存の代わりに使う。
function inert(): any {
	const proxy: any = new Proxy(function () {}, {
		get: (_target, property) => {
			if (property === 'then') {
				return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve([]).then(resolve, reject);
			}
			if (property === Symbol.iterator) {
				return [][Symbol.iterator];
			}
			return proxy;
		},
		apply: () => proxy,
	});
	return proxy;
}

afterEach(() => {
	vi.useRealTimers();
});

/**
 * 本家の EndedPollNotificationProcessorService.process を、本家の NotificationService.createNotification へつないで動かす。
 * NotificationService は、Redis の XADD（本家の通知の保存）までを実際に通し、pack が null を返す stub で配信の手前で止める。
 */
async function runProcessor(noteId: string, c: ProcessorCase) {
	const queries: unknown[][] = [];
	const createNotificationCalls: unknown[] = [];
	const stored: unknown[] = [];

	const notesRepository = {
		findOneBy: async (where: { id: string }) => {
			queries.push(['notes.findOneBy', where]);
			return c.note === null ? null : { id: noteId, ...c.note };
		},
	};
	// 本家の QueryBuilder の呼び出しを記録し、innerJoin した user の host IS NULL だけを stub で再現する。SQL 自体は新実装の結合テストで確かめる。
	const pollVotesRepository = {
		createQueryBuilder: (alias: string) => {
			queries.push(['pollVotes.createQueryBuilder', alias]);
			const builder = {
				select: (...args: unknown[]) => (queries.push(['select', ...args]), builder),
				where: (...args: unknown[]) => (queries.push(['where', ...args]), builder),
				innerJoinAndSelect: (...args: unknown[]) => (queries.push(['innerJoinAndSelect', ...args]), builder),
				andWhere: (...args: unknown[]) => (queries.push(['andWhere', ...args]), builder),
				getMany: async () => c.votes.filter(vote => vote.userHost === null).map(vote => ({ userId: vote.userId, user: { id: vote.userId, host: vote.userHost } })),
			};
			return builder;
		},
	};
	const cacheService = {
		userProfileCache: {
			// 本家の fetcher は findOneByOrFail。行がなければ EntityNotFoundError を投げる。
			fetch: async (userId: string) => {
				const profile = c.profiles[userId];
				if (profile === undefined) {
					throw Object.assign(new Error(`Could not find any entity of type "MiUserProfile" matching: { "userId": "${userId}" }`), { name: 'EntityNotFoundError' });
				}
				return { userId, ...profile };
			},
		},
	};
	const redisClient = {
		xadd: async (key: string, ...args: string[]) => {
			const recipientId = key.replace(/^notificationTimeline:/, '');
			if (c.storeFailsFor?.includes(recipientId)) {
				throw new Error('probe store failure');
			}
			const notification = JSON.parse(args[args.indexOf('data') + 1]);
			stored.push({ recipientId, maxlen: args.slice(0, 3), notification: { ...notification, id: '{id}', createdAt: '{createdAt}' } });
			return '1-0';
		},
		get: async () => null,
	};
	const notificationService = new NotificationService(
		{ perUserNotificationsMaxCount: 500 } as never,
		redisClient as never,
		{} as never,
		{ pack: async () => null } as never,
		{ gen: () => 'generated', parseFull: () => ({ date: 0, additional: 0n }) } as never,
		{} as never,
		{} as never,
		cacheService as never,
		{} as never,
	);
	const createNotification = notificationService.createNotification.bind(notificationService);
	notificationService.createNotification = ((...args: unknown[]) => {
		createNotificationCalls.push(args);
		return (createNotification as (...a: unknown[]) => void)(...args);
	}) as never;

	const processor = new EndedPollNotificationProcessorService(
		notesRepository as never,
		pollVotesRepository as never,
		cacheService as never,
		notificationService,
		{ logger: { createSubLogger: () => ({}) } } as never,
	);

	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on('unhandledRejection', onRejection);
	let result: Record<string, unknown>;
	try {
		await processor.process({ data: { noteId } } as never);
		result = { returned: true };
	} catch (error) {
		const e = error as Error;
		result = { thrown: { name: e.name } };
	}
	// createNotification は待たれない。保存まで流しきってから記録する。
	await allSettled();
	await setImmediate();
	process.off('unhandledRejection', onRejection);

	return {
		id: c.id,
		result,
		queries,
		createNotificationCalls,
		stored,
		unhandledRejections: rejections.map(reason => (reason as Error).message),
	};
}

test('pinned upstream EndedPollNotificationProcessorService', async () => {
	expect(process.env.NODE_ENV).toBe('test');
	const { path, inputs, cases } = load<{ noteId: string; cases: ProcessorCase[] }, unknown[]>('processor-cases.json');
	const actual: unknown[] = [];
	for (const c of inputs.cases) {
		actual.push(await runProcessor(inputs.noteId, c));
	}
	settle(path, inputs, cases, actual);
});

type PollInput = { id: string; poll: { expiresAt: string | null } | null };

/**
 * 本家の NoteCreateService.postNoteCreated を、投票終了ジョブの投入に関係しない依存をすべて inert にして動かす。
 * 投入は silent の分岐より前にあるため、silent の値を変えても同じ投入になることを記録する。
 */
async function runEnqueue(now: string, noteId: string, input: PollInput, silent: boolean) {
	const added: unknown[] = [];
	// 未設定のフィールドはすべて inert として読ませる。
	const service = Object.create(new Proxy(NoteCreateService.prototype, {
		get: (target, property, receiver) => property in target ? Reflect.get(target, property, receiver) : inert(),
	}));
	service.config = { host: 'probe.test' };
	service.meta = { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false, enableChartsForFederatedInstances: false };
	service.queueService = {
		endedPollNotificationQueue: {
			add: (...args: unknown[]) => {
				added.push(args);
				return Promise.resolve();
			},
		},
	};

	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(now));
	const note = { id: noteId, userId: 'author', visibility: 'public', localOnly: true, hasPoll: input.poll !== null, replyId: null, renoteId: null };
	const data = {
		visibility: 'public', localOnly: true, reply: null, renote: null, channel: null,
		poll: input.poll === null ? null : { choices: ['a', 'b'], multiple: false, expiresAt: input.poll.expiresAt === null ? null : new Date(input.poll.expiresAt) },
	};
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on('unhandledRejection', onRejection);
	try {
		await service.postNoteCreated(note, { id: 'author', username: 'author', host: null, isBot: false }, data, silent, [], []);
	} catch {
		// 投入より後の通知・配信の処理は inert の依存で失敗しうる。記録するのは投入だけ。
	}
	vi.useRealTimers();
	await setImmediate();
	process.off('unhandledRejection', onRejection);
	return added;
}

test('pinned upstream endedPollNotification enqueue, queue and worker options', async () => {
	const { path, inputs, cases } = load<{ now: string; noteId: string; polls: PollInput[]; redisForJobQueue: { id: string; options: Record<string, unknown> }[] }, unknown>('job-cases.json');

	const enqueue: unknown[] = [];
	for (const input of inputs.polls) {
		const calls = await runEnqueue(inputs.now, inputs.noteId, input, false);
		expect(await runEnqueue(inputs.now, inputs.noteId, input, true)).toEqual(calls);
		enqueue.push({ id: input.id, calls });
	}

	const queues = inputs.redisForJobQueue.map(({ id, options }) => ({
		id,
		queueName: QUEUE.ENDED_POLL_NOTIFICATION,
		queueOptions: JSON.parse(JSON.stringify(baseQueueOptions({ redisForJobQueue: options } as never, QUEUE.ENDED_POLL_NOTIFICATION))),
		// JSON に undefined は残らないため、keyPrefix の値を別に記録する。
		connectionKeyPrefix: (baseQueueOptions({ redisForJobQueue: options } as never, QUEUE.ENDED_POLL_NOTIFICATION).connection as { keyPrefix?: string }).keyPrefix ?? null,
	}));

	// Worker の設定と、processor が失敗したときのログ・再送出を記録する。
	workers.length = 0;
	const logs: unknown[] = [];
	const captured: unknown[] = [];
	const failure = new Error('probe processor failure');
	const logger = { error: (...args: unknown[]) => logs.push(['error', args[0]]), warn: () => {}, debug: () => {}, info: () => {}, succ: () => {} };
	const deps = Array.from({ length: 38 }, () => ({ process: async () => { throw failure; } }));
	new (QueueProcessorService as any)(
		{ redisForJobQueue: inputs.redisForJobQueue[0].options },
		{ logger: { createSubLogger: () => logger, ...logger } },
		{ startSpan: (_name: string, fn: () => unknown) => fn(), captureMessage: (message: string) => captured.push(message) },
		...deps,
	);
	const worker = workers.find(w => w.name === QUEUE.ENDED_POLL_NOTIFICATION)!;
	let rethrown: unknown;
	try {
		await worker.processor({ id: '1', name: inputs.noteId, data: { noteId: inputs.noteId }, attemptsMade: 0, timestamp: Date.now(), opts: {} });
	} catch (error) {
		rethrown = error;
	}

	const actual = {
		enqueue,
		queues,
		worker: {
			name: worker.name,
			opts: JSON.parse(JSON.stringify(worker.opts)),
			events: worker.events,
			onFailure: { logs, captured, rethrowsOriginal: rethrown === failure },
		},
		workerNames: workers.map(w => w.name),
	};
	settle(path, inputs, cases, actual);
});
