/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { Job, UnrecoverableError } from 'bullmq';
import * as mfm from 'mfm-js';
import { FindOperator } from 'typeorm';
import { afterEach, expect, test, vi } from 'vitest';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { ApMfmService } from '@/core/activitypub/ApMfmService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { IdService } from '@/core/IdService.js';
import { MfmService } from '@/core/MfmService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { QueueService } from '@/core/QueueService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { allSettled } from '@/misc/promise-tracker.js';
import { StatusError } from '@/misc/status-error.js';
import { baseQueueOptions, QUEUE } from '@/queue/const.js';
import { DeliverProcessorService } from '@/queue/processors/DeliverProcessorService.js';
import { QueueProcessorService } from '@/queue/QueueProcessorService.js';

// 対象はre2を使わない。ネイティブモジュールを.node-versionのNodeで再ビルドせずに実行できるよう差し替える。
vi.mock('re2', () => ({ default: class {} }));

// QueueProcessorService が作る Worker の名前・設定・イベントの受け手・processor を記録する。Redis へは接続しない。
const workers = vi.hoisted(() => [] as { name: string; processor: (job: unknown) => Promise<unknown>; opts: Record<string, any>; handlers: [string, (...args: any[]) => unknown][] }[]);
vi.mock('bullmq', async original => {
	const actual = await original<typeof import('bullmq')>();
	class RecordingWorker {
		handlers: [string, (...args: any[]) => unknown][] = [];
		constructor(public name: string, public processor: (job: unknown) => Promise<unknown>, public opts: Record<string, unknown>) {
			workers.push(this);
		}

		on(event: string, handler: (...args: any[]) => unknown) {
			this.handlers.push([event, handler]);
			return this;
		}
	}
	return { ...actual, Worker: RecordingWorker };
});

const write = process.env.AP_DELIVER_PROBE_WRITE === '1';

function load<T, C = unknown[]>(name: string): { path: URL; inputs: T; cases: C } {
	const path = new URL(`./${name}`, import.meta.url);
	return { path, ...JSON.parse(readFileSync(path, 'utf8')) };
}

function settle(path: URL, inputs: unknown, stored: unknown, actual: unknown) {
	const plain = JSON.parse(JSON.stringify(actual));
	if (write) {
		writeFileSync(path, JSON.stringify({ inputs, cases: plain }, null, '\t') + '\n');
		return;
	}
	expect(plain).toEqual(stored);
}

function errorShape(error: unknown) {
	const e = error as Error;
	return { name: e.name, message: e.message };
}

// TypeORM の In()・Not()・IsNull() を JSON で読める形にする。
function normalize(value: unknown): unknown {
	if (value instanceof FindOperator) {
		// value の getter は入れ子の演算子（Not(IsNull()) など）を剥がすため、元の値を読む。
		return { operator: value.type, value: normalize((value as unknown as { _value: unknown })._value) };
	}
	if (Array.isArray(value)) {
		return value.map(normalize);
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value != null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
	}
	return value;
}

// 呼ばれたメソッドを問わず、自分自身か「解決すると [] になる値」を返す。配送に関係しない依存の代わりに使う。
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

// 与えたメソッドだけを実際に動かし、それ以外は inert にする。
function partial<T extends object>(known: T): T {
	return new Proxy(known, {
		get: (target, property, receiver) => property in target ? Reflect.get(target, property, receiver) : inert(),
	});
}

// 待たれない処理の失敗を記録する。Vitest の受け手は失敗として扱うため、記録の間だけ外す。
async function captureRejections<T>(run: () => Promise<T>): Promise<{ value: T; rejections: string[] }> {
	const rejections: string[] = [];
	const saved = process.listeners('unhandledRejection');
	process.removeAllListeners('unhandledRejection');
	const onRejection = (reason: unknown) => rejections.push((reason as Error).message);
	process.on('unhandledRejection', onRejection);
	try {
		const value = await run();
		return { value, rejections };
	} finally {
		process.off('unhandledRejection', onRejection);
		for (const listener of saved) {
			process.on('unhandledRejection', listener);
		}
	}
}

async function flush(ticks = 30) {
	for (let i = 0; i < ticks; i++) {
		await setImmediate();
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

//#region MFM → HTML

type MfmCase = { id: string; text: string | null; mentionedRemoteUsers?: unknown[]; extraHtml?: string | null };

function nodeTypes(nodes: mfm.MfmNode[], into = new Set<string>()) {
	for (const node of nodes) {
		into.add(node.type);
		if ('children' in node && node.children) {
			nodeTypes(node.children, into);
		}
	}
	return into;
}

test('pinned upstream MfmService.toHtml through ApMfmService.getNoteHtml', () => {
	const { path, inputs, cases } = load<{ selfUrl: string; mentionedRemoteUsers: unknown[]; cases: MfmCase[] }>('mfm-html-cases.json');
	const mfmService = new MfmService({ url: inputs.selfUrl } as never);
	const apMfmService = new ApMfmService(mfmService);

	const covered = new Set<string>();
	const actual = inputs.cases.map(c => {
		const types = [...nodeTypes(mfm.parse(c.text ?? ''))].sort();
		types.forEach(t => covered.add(t));
		const note = { text: c.text, mentionedRemoteUsers: JSON.stringify(c.mentionedRemoteUsers ?? inputs.mentionedRemoteUsers) };
		try {
			const { content, noMisskeyContent } = apMfmService.getNoteHtml(note, c.extraHtml ?? null);
			return { id: c.id, nodeTypes: types, content, noMisskeyContent };
		} catch (error) {
			return { id: c.id, nodeTypes: types, error: errorShape(error) };
		}
	});

	// 本家の toHtml の handler をすべて通したことを確かめる。
	expect([...covered].sort()).toEqual([
		'blockCode', 'bold', 'center', 'emojiCode', 'fn', 'hashtag', 'inlineCode', 'italic', 'link', 'mathBlock',
		'mathInline', 'mention', 'plain', 'quote', 'search', 'small', 'strike', 'text', 'unicodeEmoji', 'url',
	]);
	expect(mfmService.toHtml(null)).toBeNull();
	settle(path, inputs, cases, actual);
});

//#endregion

//#region renderNoteOrRenoteActivity と宛先

type UserFixture = { id: string; username: string; host: string | null; uri: string | null; inbox: string | null; sharedInbox: string | null; profileUrl: string | null };
type NoteFixture = Record<string, any> & { id: string; userId: string; fileIds: string[]; hasPoll: boolean; mentions: string[] };
type RenderInputs = {
	selfUrl: string;
	now: string;
	users: UserFixture[];
	notes: NoteFixture[];
	files: Record<string, any>[];
	polls: Record<string, { noteId: string; choices: string[]; multiple: boolean; votes: number[]; expiresAt: string | null }>;
	emojis: Record<string, any>[];
	cases: { id: string; note: NoteFixture; followers: string[]; deletedBeforeRender: string[]; author: string }[];
};

function createRenderer(inputs: RenderInputs, deleted: Set<string>, config: Record<string, unknown>) {
	const users = new Map(inputs.users.map(u => [u.id, u]));
	const notes = new Map(inputs.notes.map(n => [n.id, n]));

	const usersRepository = partial({
		// 本家は ORDER BY を付けない。stub は表の順で返し、メンションの順と違う場合を作れるようにする。
		findBy: async ({ id }: { id: FindOperator<string[]> }) => inputs.users.filter(u => id.value.includes(u.id)),
		exists: async ({ where }: { where: { id: string } }) => users.has(where.id),
		findOneBy: async ({ id }: { id: string }) => users.get(id) ?? null,
	});
	const notesRepository = { findOneBy: async ({ id }: { id: string }) => deleted.has(id) ? null : notes.get(id) ?? null };
	const driveFilesRepository = { findBy: async ({ id }: { id: FindOperator<string[]> }) => inputs.files.filter(f => id.value.includes(f.id)) };
	const pollsRepository = {
		findOneBy: async ({ noteId }: { noteId: string }) => {
			const poll = inputs.polls[noteId];
			return poll ? { ...poll, expiresAt: poll.expiresAt ? new Date(poll.expiresAt) : null } : null;
		},
	};
	const customEmojiService = {
		localEmojisCache: {
			fetch: async () => new Map(inputs.emojis.map(e => [e.name, { ...e, updatedAt: e.updatedAt ? new Date(e.updatedAt) : null }])),
		},
	};
	// isLocalUser・isRemoteUser は constructor で設定されるフィールド。constructor は依存を保持するだけなので、config だけを与えて作る。
	const userEntityService = Object.assign(new (UserEntityService as any)(), { config });
	const driveFileEntityService = Object.assign(Object.create(DriveFileEntityService.prototype), { config, meta: { proxyRemoteFiles: true } });
	const mfmService = new MfmService(config as never);
	const idService = new IdService(config as never);

	const renderer = new ApRendererService(
		config as never,
		{} as never,
		usersRepository as never,
		{} as never,
		notesRepository as never,
		driveFilesRepository as never,
		pollsRepository as never,
		customEmojiService as never,
		userEntityService,
		driveFileEntityService,
		{} as never,
		{} as never,
		new ApMfmService(mfmService),
		mfmService,
		idService,
		{} as never,
	);
	return { renderer, usersRepository, userEntityService, idService, users, notes };
}

/**
 * 本家の NoteCreateService.postNoteCreated を silent=false で動かし、AP 配送の区画（NoteCreateService.ts:889-923）を通す。
 * 配送に関係しない依存は inert にする。宛先は本家の ApDeliverManagerService と QueueService.deliverMany を通し、addBulk の引数を記録する。
 */
async function runRender(inputs: RenderInputs, c: RenderInputs['cases'][number]) {
	const config = { url: inputs.selfUrl, host: new URL(inputs.selfUrl).host, id: 'aidx' };
	const { renderer, usersRepository, userEntityService, idService, users, notes } = createRenderer(inputs, new Set(c.deletedBeforeRender), config);

	const followingsQueries: unknown[] = [];
	const followingsRepository = {
		find: async (options: unknown) => {
			followingsQueries.push(normalize(options));
			return c.followers.map(id => users.get(id)!).map(u => ({ followerSharedInbox: u.sharedInbox, followerInbox: u.inbox }));
		},
	};
	const addBulk: { name: string; data: Record<string, unknown>; opts: unknown }[][] = [];
	const queueService = Object.assign(Object.create(QueueService.prototype), {
		config: {},
		deliverQueue: { addBulk: async (jobs: typeof addBulk[number]) => { addBulk.push(jobs); } },
	});
	const deliverManagerService = new ApDeliverManagerService(followingsRepository as never, userEntityService, queueService);
	const activities: unknown[] = [];
	const createDeliverManager = deliverManagerService.createDeliverManager;
	deliverManagerService.createDeliverManager = ((actor: never, activity: unknown) => {
		activities.push(activity);
		return createDeliverManager(actor, activity as never);
	}) as never;
	const relay: unknown[] = [];
	const relayService = { deliverToRelays: async (_user: unknown, activity: unknown) => { relay.push(activity); } };

	const lookups: string[] = [];
	const service = Object.create(new Proxy(NoteCreateService.prototype, {
		get: (target, property, receiver) => property in target ? Reflect.get(target, property, receiver) : inert(),
	}));
	Object.assign(service, {
		config,
		meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false, enableChartsForFederatedInstances: false },
		userEntityService,
		usersRepository: partial({
			findOneBy: async (where: { id: string }) => {
				lookups.push(where.id);
				return usersRepository.findOneBy(where);
			},
		}),
		apRendererService: renderer,
		apDeliverManagerService: deliverManagerService,
		relayService,
		idService,
	});

	// 保存済みの列から本家の入力 data を組み立てる。pure Renote の判定（isRenote && !isQuote）はこの data で行われる。
	const note = c.note;
	const poll = inputs.polls[note.id];
	const data = {
		visibility: note.visibility,
		localOnly: note.localOnly,
		channel: note.channelId ? { id: note.channelId } : null,
		reply: note.replyId ? notes.get(note.replyId) ?? null : null,
		renote: note.renoteId ? notes.get(note.renoteId) ?? null : null,
		text: note.text,
		cw: note.cw,
		files: note.fileIds.map(id => inputs.files.find(f => f.id === id) ?? { id }),
		poll: note.hasPoll ? { choices: poll?.choices ?? ['x'], multiple: poll?.multiple ?? false, expiresAt: poll?.expiresAt ? new Date(poll.expiresAt) : null } : null,
	};
	const author = users.get(c.author)!;
	const mentionedUsers = note.mentions.map(id => users.get(id)!);

	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(inputs.now));
	const { rejections } = await captureRejections(async () => {
		try {
			await service.postNoteCreated(note, { id: author.id, username: author.username, host: author.host, isBot: false }, data, false, note.tags, mentionedUsers);
		} catch {
			// 配送の区画より前の、inert の依存による失敗は記録しない。区画に届いたかは activities で分かる。
		}
		await flush();
		await allSettled();
		await flush();
	});
	vi.useRealTimers();

	expect(addBulk.length).toBeLessThanOrEqual(1);
	const jobs = addBulk[0] ?? null;
	const activity = activities.length > 0 ? JSON.stringify(activities[0]) : null;
	if (jobs) {
		for (const job of jobs) {
			// 全 job が同じ本文・digest・user を持つ。本文は renderNoteOrRenoteActivity の結果を 1 回だけ JSON にしたもの。
			expect(job.data.content).toBe(activity);
			expect(job.data.digest).toBe(jobs[0].data.digest);
			expect(job.data.user).toEqual({ id: author.id });
		}
	}

	return {
		id: c.id,
		reachedDeliver: activities.length > 0,
		activity,
		relay: relay.length > 0,
		directUserLookups: lookups,
		followingsQueries,
		addBulk: jobs === null ? null : {
			digest: jobs[0]?.data.digest ?? null,
			jobs: jobs.map(job => ({ name: job.name, to: job.data.to, isSharedInbox: job.data.isSharedInbox })),
		},
		unhandledRejections: rejections,
	};
}

test('pinned upstream renderNoteOrRenoteActivity and note delivery recipients', async () => {
	const { path, inputs, cases } = load<RenderInputs>('render-cases.json');
	const actual: unknown[] = [];
	for (const c of inputs.cases) {
		actual.push(await runRender(inputs, c));
	}
	settle(path, inputs, cases, actual);
});

//#endregion

//#region DeliverManager

type Recipe = { type: 'Followers' } | { type: 'Direct'; to: { inbox: string | null; sharedInbox: string | null } };
type RecipientInputs = {
	actorId: string;
	activity: Record<string, unknown>;
	cases: { id: string; recipes: Recipe[]; followings: { followerSharedInbox: string | null; followerInbox: string | null }[]; activity?: null; actorHost?: string }[];
};

test('pinned upstream ApDeliverManagerService DeliverManager.execute', async () => {
	const { path, inputs, cases } = load<RecipientInputs>('recipient-cases.json');
	const actual: unknown[] = [];

	for (const c of inputs.cases) {
		const followingsQueries: unknown[] = [];
		const followingsRepository = {
			find: async (options: unknown) => {
				followingsQueries.push(normalize(options));
				return c.followings;
			},
		};
		const deliverMany: unknown[] = [];
		const queueService = {
			deliverMany: async (user: unknown, activity: unknown, inboxes: Map<string, boolean>) => {
				deliverMany.push({ user, activity, inboxes: [...inboxes.entries()] });
			},
		};
		const service = new ApDeliverManagerService(followingsRepository as never, {} as never, queueService as never);

		let error: unknown = null;
		try {
			const manager = service.createDeliverManager({ id: inputs.actorId, host: (c.actorHost ?? null) as null }, c.activity === null ? null : inputs.activity as never);
			for (const recipe of c.recipes) {
				if (recipe.type === 'Followers') {
					manager.addFollowersRecipe();
				} else {
					manager.addDirectRecipe(recipe.to as never);
				}
			}
			await manager.execute();
		} catch (e) {
			error = errorShape(e);
		}

		actual.push({ id: c.id, ...(error ? { error } : {}), followingsQueries, deliverMany: deliverMany[0] ?? null });
	}

	settle(path, inputs, cases, actual);
});

//#endregion

//#region 投入・queue・Worker

type JobInputs = {
	now: string;
	user: { id: string };
	activity: Record<string, unknown>;
	inboxes: [string, boolean][];
	deliver: { id: string; to: string | null; isSharedInbox: boolean; contentNull?: boolean }[];
	configs: { id: string; config: Record<string, unknown> }[];
	redisForJobQueue: { id: string; options: Record<string, unknown> }[];
	backoff: { attemptsMade: number[]; random: number[] };
	retry: { attempts: number[]; errors: { id: string; name?: string; message: string; unrecoverable?: boolean }[]; random: number };
};

function recordingQueueService(config: Record<string, unknown>) {
	const calls: unknown[] = [];
	const service = Object.assign(Object.create(QueueService.prototype), {
		config,
		deliverQueue: {
			add: async (...args: unknown[]) => { calls.push(['add', ...args]); },
			addBulk: async (jobs: unknown[]) => { calls.push(['addBulk', jobs]); },
		},
	});
	return { service: service as QueueService, calls };
}

function deliverWorker(config: Record<string, unknown>, redisForJobQueue: Record<string, unknown>) {
	workers.length = 0;
	const logs: unknown[] = [];
	const captured: unknown[] = [];
	const failure = new Error('probe processor failure');
	const record = (level: string) => (message: string, extra?: { e?: unknown }) => {
		const e = extra?.e;
		logs.push([level, message, ...(e === undefined ? [] : [typeof e === 'string' ? e : errorShape(e)])]);
	};
	const logger = { error: record('error'), warn: record('warn'), debug: record('debug'), info: record('info'), succ: record('succ') };
	const deps = Array.from({ length: 38 }, () => ({ process: async () => { throw failure; } }));
	new (QueueProcessorService as any)(
		{ ...config, redisForJobQueue },
		{ logger: { createSubLogger: () => logger, ...logger } },
		{ startSpan: (_name: string, fn: () => unknown) => fn(), captureMessage: (message: string) => captured.push(message) },
		...deps,
	);
	const names = workers.map(w => w.name);
	return { worker: workers.find(w => w.name === QUEUE.DELIVER)!, names, logs, captured, failure };
}

test('pinned upstream deliver enqueue, queue, worker options and backoff', async () => {
	const { path, inputs, cases } = load<JobInputs, unknown>('job-cases.json');
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(inputs.now));

	const enqueue = [];
	for (const { id, config } of inputs.configs) {
		const many = recordingQueueService(config);
		await many.service.deliverMany(inputs.user, inputs.activity as never, new Map(inputs.inboxes));
		const empty = recordingQueueService(config);
		await empty.service.deliverMany(inputs.user, inputs.activity as never, new Map());
		const nullActivity = recordingQueueService(config);
		const nullResult = await nullActivity.service.deliverMany(inputs.user, null, new Map(inputs.inboxes));
		const single = recordingQueueService(config);
		const deliver = [];
		for (const d of inputs.deliver) {
			single.calls.length = 0;
			const returned = await single.service.deliver(inputs.user, d.contentNull ? null : inputs.activity as never, d.to, d.isSharedInbox);
			deliver.push({ id: d.id, returnedNull: returned === null, calls: [...single.calls] });
		}
		enqueue.push({
			id,
			deliverMany: many.calls,
			deliverManyEmpty: empty.calls,
			deliverManyNullActivity: { returnedNull: nullResult === null, calls: nullActivity.calls },
			deliver,
		});
	}

	const queues = inputs.redisForJobQueue.map(({ id, options }) => ({
		id,
		queueName: QUEUE.DELIVER,
		queueOptions: JSON.parse(JSON.stringify(baseQueueOptions({ redisForJobQueue: options } as never, QUEUE.DELIVER))),
		connectionKeyPrefix: (baseQueueOptions({ redisForJobQueue: options } as never, QUEUE.DELIVER).connection as { keyPrefix?: string }).keyPrefix ?? null,
	}));

	const workerOptions = inputs.configs.map(({ id, config }) => {
		const { worker } = deliverWorker(config, inputs.redisForJobQueue[0].options);
		return {
			id,
			opts: JSON.parse(JSON.stringify(worker.opts)),
			backoffStrategy: typeof worker.opts.settings?.backoffStrategy,
		};
	});

	// 失敗した試行のログ・telemetry・投げ直しと、イベントの受け手のログを記録する。
	const { worker, names, logs, captured, failure } = deliverWorker({}, inputs.redisForJobQueue[0].options);
	const job = { id: '1', name: 'remote.example', data: { user: inputs.user, content: '{}', digest: 'SHA-256=probe', to: 'https://remote.example/inbox', isSharedInbox: true }, attemptsMade: 0, timestamp: Date.now() - 90 * 1000, opts: { attempts: 12 } };
	let rethrown: unknown;
	try {
		await worker.processor(job);
	} catch (error) {
		rethrown = error;
	}
	const failureLogs = [...logs];
	logs.length = 0;
	for (const [event, handler] of worker.handlers) {
		switch (event) {
			case 'active': handler(job); break;
			case 'completed': handler(job, 'Success'); break;
			case 'error': handler(new Error('probe worker error')); break;
			case 'stalled': handler('1'); break;
		}
	}

	const strategy = worker.opts.settings.backoffStrategy as (attemptsMade: number) => number;
	const backoff = inputs.backoff.random.map(random => {
		vi.spyOn(Math, 'random').mockReturnValue(random);
		const delays = inputs.backoff.attemptsMade.map(n => strategy(n));
		vi.restoreAllMocks();
		return { random, delays };
	});

	// BullMQ の Job.shouldRetryJob に本家の Worker の設定を渡し、試行回数ごとの再試行の有無と待ち時間を記録する。
	vi.spyOn(Math, 'random').mockReturnValue(inputs.retry.random);
	const retry = [];
	for (const attempts of inputs.retry.attempts) {
		for (const e of inputs.retry.errors) {
			const err = e.unrecoverable ? new UnrecoverableError(e.message) : Object.assign(new Error(e.message), { name: e.name });
			const decisions = [];
			for (let attemptsMade = 0; attemptsMade < attempts; attemptsMade++) {
				const fake = { attemptsMade, opts: { attempts, backoff: { type: 'custom' } }, queue: { opts: worker.opts } };
				const [shouldRetry, delay] = await (Job.prototype as any).shouldRetryJob.call(fake, err);
				decisions.push({ attemptsMade, shouldRetry, delay });
			}
			retry.push({ attempts, error: e.id, decisions });
		}
	}
	vi.restoreAllMocks();
	vi.useRealTimers();

	const actual = {
		enqueue,
		queues,
		workerOptions,
		worker: {
			name: worker.name,
			events: worker.handlers.map(([event]) => event),
			onFailure: { logs: failureLogs, captured, rethrowsOriginal: rethrown === failure },
			eventLogs: logs,
		},
		workerNames: names,
		backoff,
		retry,
	};
	settle(path, inputs, cases, actual);
});

//#endregion

//#region DeliverProcessorService

type InstanceFixture = Record<string, unknown> & { id: string; host: string };
type Failure =
	| { kind: 'none' }
	| { kind: 'status'; statusCode: number; statusMessage?: string }
	| { kind: 'error'; name: string; message: string; props?: Record<string, unknown> };
type Step = { to: string; isSharedInbox: boolean; failure: Failure; advanceMs?: number };
type ProcessorInputs = {
	now: string;
	selfHost: string;
	job: { user: { id: string }; content: string; digest: string };
	meta: Record<string, unknown>;
	cases: { id: string; meta: Record<string, unknown>; instances: InstanceFixture[]; suspendedHostsCache?: InstanceFixture[]; steps: Step[] }[];
};

const instanceDefaults = {
	firstRetrievedAt: null as unknown,
	usersCount: 0,
	notesCount: 0,
	followingCount: 0,
	followersCount: 0,
	latestRequestReceivedAt: null,
	isNotResponding: false,
	notRespondingSince: null,
	suspensionState: 'none',
	softwareName: null,
	softwareVersion: null,
	openRegistrations: null,
	name: null,
	description: null,
	maintainerName: null,
	maintainerEmail: null,
	iconUrl: null,
	faviconUrl: null,
	themeColor: null,
	infoUpdatedAt: null,
	moderationNote: '',
};

function toRow(fixture: Record<string, unknown>) {
	const row: Record<string, unknown> = { id: fixture.id, host: fixture.host, ...instanceDefaults, firstRetrievedAt: new Date('2026-01-01T00:00:00.000Z'), ...fixture };
	for (const key of ['firstRetrievedAt', 'notRespondingSince', 'latestRequestReceivedAt', 'infoUpdatedAt']) {
		if (typeof row[key] === 'string') {
			row[key] = new Date(row[key] as string);
		}
	}
	return row;
}

function failureOf(failure: Failure): unknown {
	switch (failure.kind) {
		case 'none':
			return null;
		case 'status':
			// HttpRequestService.send と同じ組み立て。
			return new StatusError(`${failure.statusCode} ${failure.statusMessage}`, failure.statusCode, failure.statusMessage);
		case 'error':
			return Object.assign(new Error(failure.message), { name: failure.name }, failure.props);
	}
}

/**
 * 本家の DeliverProcessorService.process を、本家の FederatedInstanceService・UtilityService とつないで動かす。
 * instance 表と Redis は記録用の stub にし、送信（signedPost）・チャート・fetchInstanceMetadata は呼び出しだけを記録する。
 */
async function runProcessor(inputs: ProcessorInputs, c: ProcessorInputs['cases'][number]) {
	let clock = Date.parse(inputs.now);
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(clock));

	const rows = new Map<string, Record<string, unknown>>(c.instances.map(f => [f.host, toRow(f)]));
	const db: unknown[] = [];
	const instancesRepository = {
		find: async (options: unknown) => {
			db.push(['find', normalize(options)]);
			return [...rows.values()].filter(r => r.suspensionState !== 'none').map(r => structuredClone(r));
		},
		findOneBy: async (where: { host: string }) => {
			db.push(['findOneBy', where]);
			const row = rows.get(where.host);
			return row ? structuredClone(row) : null;
		},
		insertOne: async (entity: Record<string, unknown>) => {
			db.push(['insertOne', normalize(entity)]);
			// instance.host は一意。PostgreSQL と同じく、同じ host の 2 件目の INSERT を失敗させる。
			if (rows.has(entity.host as string)) {
				throw Object.assign(new Error('duplicate key value violates unique constraint'), { name: 'QueryFailedError' });
			}
			const row = { ...instanceDefaults, ...entity };
			rows.set(entity.host as string, row);
			return structuredClone(row);
		},
		createQueryBuilder: () => {
			let patch: Record<string, unknown> = {};
			let id: string | undefined;
			const builder = {
				update: () => builder,
				set: (data: Record<string, unknown>) => { patch = data; return builder; },
				where: (_sql: string, params: { id: string }) => { id = params.id; return builder; },
				returning: () => builder,
				execute: async () => {
					db.push(['update', id, normalize(patch)]);
					const row = [...rows.values()].find(r => r.id === id);
					if (row) {
						Object.assign(row, patch);
					}
					return { raw: row ? [structuredClone(row)] : [] };
				},
			};
			return builder;
		},
	};

	const redisStore = new Map<string, { value: string; expiresAt: number | null }>();
	const redisSets: unknown[] = [];
	const redis = {
		get: async (key: string) => {
			const entry = redisStore.get(key);
			if (entry == null || (entry.expiresAt !== null && entry.expiresAt <= Date.now())) {
				return null;
			}
			return entry.value;
		},
		set: async (key: string, value: string, ...args: unknown[]) => {
			redisSets.push(['set', key, value, ...args]);
			redisStore.set(key, { value, expiresAt: args[0] === 'EX' ? Date.now() + (args[1] as number) * 1000 : null });
			return 'OK';
		},
	};

	const meta = { ...inputs.meta, ...c.meta };
	const utilityService = new UtilityService({ host: inputs.selfHost } as never, meta as never);
	let registered = 0;
	const federatedInstanceService = new FederatedInstanceService(redis as never, instancesRepository as never, utilityService, { gen: () => `registered-${++registered}` } as never);
	const serviceCalls: unknown[] = [];
	for (const method of ['fetch', 'fetchOrRegister', 'update'] as const) {
		const original = federatedInstanceService[method] as (...args: unknown[]) => unknown;
		(federatedInstanceService as any)[method] = (...args: unknown[]) => {
			serviceCalls.push([method, ...normalize(args) as unknown[]]);
			return original(...args);
		};
	}

	const outOfScope: unknown[] = [];
	const signedPosts: unknown[] = [];
	let failure: unknown = null;
	const processor = new DeliverProcessorService(
		meta as never,
		instancesRepository as never,
		utilityService,
		federatedInstanceService,
		{ fetchInstanceMetadata: async (i: { host: string }) => { outOfScope.push(['fetchInstanceMetadata', i.host]); } } as never,
		{ signedPost: async (...args: unknown[]) => { signedPosts.push(args); if (failure) { throw failure; } } } as never,
		{ requestSent: (host: string, ok: boolean) => { outOfScope.push(['instanceChart.requestSent', host, ok]); } } as never,
		{ deliverSucc: () => { outOfScope.push(['apRequestChart.deliverSucc']); }, deliverFail: () => { outOfScope.push(['apRequestChart.deliverFail']); } } as never,
		{ deliverd: (host: string, ok: boolean) => { outOfScope.push(['federationChart.deliverd', host, ok]); } } as never,
		{ logger: { createSubLogger: () => ({}) } } as never,
	);
	if (c.suspendedHostsCache) {
		(processor as any).suspendedHostsCache.set(c.suspendedHostsCache.map(toRow));
	}

	const steps = [];
	for (const s of c.steps) {
		if (s.advanceMs) {
			clock += s.advanceMs;
			vi.setSystemTime(new Date(clock));
		}
		failure = failureOf(s.failure);
		db.length = 0;
		redisSets.length = 0;
		serviceCalls.length = 0;
		outOfScope.length = 0;
		signedPosts.length = 0;

		const { value: result, rejections } = await captureRejections(async () => {
			let r: Record<string, unknown>;
			try {
				r = { returned: await processor.process({ data: { ...inputs.job, to: s.to, isSharedInbox: s.isSharedInbox } } as never) };
			} catch (error) {
				const e = error as Error;
				r = { thrown: { name: e.name, message: e.message, unrecoverable: e instanceof UnrecoverableError, original: failure !== null && e === failure } };
			}
			// 成功時の更新は process.nextTick、失敗時の更新は待たれない then で走る。流しきってから記録する。
			await flush();
			return r;
		});

		steps.push({
			at: new Date(clock).toISOString(),
			to: s.to,
			isSharedInbox: s.isSharedInbox,
			failure: s.failure,
			...result,
			signedPosts: normalize(signedPosts),
			instanceServiceCalls: [...serviceCalls],
			db: [...db],
			redisSets: [...redisSets],
			outOfScope: [...outOfScope],
			unhandledRejections: rejections,
		});
	}

	federatedInstanceService.dispose();
	vi.useRealTimers();

	return {
		id: c.id,
		steps,
		instances: [...rows.values()].map(r => normalize(r)).sort((a: any, b: any) => a.host.localeCompare(b.host)),
	};
}

test('pinned upstream DeliverProcessorService.process with FederatedInstanceService', async () => {
	const { path, inputs, cases } = load<ProcessorInputs>('processor-cases.json');
	const actual: unknown[] = [];
	for (const c of inputs.cases) {
		actual.push(await runProcessor(inputs, c));
	}
	settle(path, inputs, cases, actual);
});

//#endregion
