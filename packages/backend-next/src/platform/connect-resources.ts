import { createOutboundHttpClient } from '../composition/outbound-http.js';
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomBytes } from 'node:crypto';
import { MiInstance } from 'backend-upstream/entities';
import { Redis } from 'ioredis';
import { createPostingAntennas } from '../composition/posting-antennas.js';
import { createHostRules } from '../modules/federation/public.js';
import { createPostingHashtags } from '../composition/posting-hashtags.js';
import { createPostingFeatured } from '../composition/posting-featured.js';
import { createPostingTimelines } from '../composition/posting-timelines.js';
import { createPostingSearch } from '../composition/posting-search.js';
import { createPostingRoleTimelines } from '../composition/posting-role-timelines.js';
import { createPostingNotifications } from '../composition/posting-notifications.js';
import { createFederationKeys } from '../composition/federation-keys.js';
import { createDeliverCreatedNote, createDeliverToRelays, createDeliverDeletedNote } from '../modules/federation/public.js';
import { createRoleTimelineReader } from './database/role-timelines.js';
import { createFeaturedRanking } from './featured-ranking.js';
import { createNoteHashtagWriter, readHashtagRankingSettings } from './database/note-hashtags.js';
import { createHashtagRanking } from './hashtag-ranking.js';
import { createNoteAntennaReader } from './database/note-antennas.js';
import { readMeta } from './database/meta.js';
import { createInstanceLedger } from './instance-ledger.js';
import { createNoteInstanceCounts } from './note-instance-counts.js';
import { openNoteAntennas } from './note-antennas.js';
import { createTimelineCache } from './timeline-cache.js';
import { createNoteTimelineReader } from './database/note-timelines.js';
import { createPostingStream } from './posting-stream.js';
import { openUserWebhooks } from './user-webhooks.js';
import { createUserWebhookQueue, USER_WEBHOOK_DELIVER } from './job-queue/user-webhook.js';
import { createNotePostDelete } from './note-post-delete.js';
import { appendNoteDeleteAudit, readDeletionConcernedUsers } from './database/note-deleter.js';
import { createAcceptedRelayReader } from './database/accepted-relays.js';
import { signRsaSignature2017 } from './jsonld-signature.js';
import { createNotePostSave, createNotePostSaveWork } from './note-post-save.js';
import { createPollEndedQueue, ENDED_POLL_NOTIFICATION } from './job-queue/ended-poll-notification.js';
import { createDeliverQueue, DELIVER } from './job-queue/deliver.js';
import { createNotePostSaveCounts } from './database/note-post-save-counts.js';
import { createNoteActivityReader } from './database/note-activity.js';
import { createDeliveryRecipientReader } from './database/delivery-recipients.js';
import { createIdCodec } from './id-codec.js';
import { openRoleMaterials } from './role-materials.js';
import { createRoleMaterialReader } from './database/role-materials.js';
import { ResourceScope } from './resource-scope.js';
import { DiagnosticError } from './diagnostic-error.js';
import { createDataSource } from './database/data-source.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Logger } from './logger.js';

export async function connectResources(config: RuntimeConfig, logger: Logger) {
	const scope = new ResourceScope();
	let cancelled = false;
	let active = false;
	let reportFailure!: (error: Error) => void;
	const failure = new Promise<Error>(resolve => {
		reportFailure = resolve;
	});
	let closing = false;
	const close = () => {
		closing = true;
		return scope.close();
	};
	let timer: NodeJS.Timeout | undefined;
	const timeout = new DiagnosticError('STARTUP_TIMEOUT', { timeoutMs: config.processes.startupTimeoutMs });

	// 投入口の接続は再接続しない。起動を終えるまでは failure を見張る側がいないため、起動中に失った接続は覚えておき、起動を失敗させる。
	// 見逃すと、子は投入できない投入口のまま ready を返し、後続処理の失敗ログだけを残して動き続ける。
	let lostQueue: string | undefined;
	let lostTimelines = false;
	const onQueueLost = (queue: string) => () => {
		if (closing) {
			return;
		}
		if (active) {
			reportFailure(new DiagnosticError('JOB_QUEUE_REDIS_ENDED', { queue }));
		} else {
			lostQueue ??= queue;
		}
	};

	const initialize = async () => {
		const dataSource = createDataSource(config.database, config.processes.startupTimeoutMs);
		scope.defer(async () => {
			if (dataSource.isInitialized) {
				await dataSource.destroy();
			}
		});

		try {
			await dataSource.initialize();
		} finally {
			// Promise.race は接続作成を中断しない。期限後に完成したプールもここで解放する必要がある。
			if (cancelled && dataSource.isInitialized) {
				await dataSource.destroy();
			}
		}
		if (cancelled) {
			throw timeout;
		}

		const redis = new Redis({
			...config.redis,
			lazyConnect: true,
			connectTimeout: config.processes.startupTimeoutMs,
			// Redis は必須なので、再接続で起動失敗を先送りせず運用側へ失敗を返す。
			retryStrategy: () => null,
			maxRetriesPerRequest: 0,
			disconnectTimeout: 0,
		});
		redis.on('error', (error) => {
			logger.error('redis.error', { error });
		});
		scope.defer(async () => {
			if (redis.status === 'end') {
				return;
			}
			await new Promise<void>((resolve) => {
				redis.once('end', resolve);
				redis.disconnect();
			});
		});

		await redis.connect();
		if (cancelled) {
			throw timeout;
		}
		await redis.ping();
		if (cancelled) {
			throw timeout;
		}

		let reactionsRedis = redis;
		if (config.redisForReactions) {
			reactionsRedis = new Redis({
				...config.redisForReactions, lazyConnect: true, retryStrategy: () => null,
				maxRetriesPerRequest: 0, disconnectTimeout: 0, connectTimeout: config.processes.startupTimeoutMs,
			});
			reactionsRedis.on('error', error => logger.error('reactions-redis.error', { error }));
			reactionsRedis.on('end', () => {
				if (active && !closing) {
					reportFailure(new DiagnosticError('REACTIONS_REDIS_ENDED', {}));
				}
			});
			const connection = reactionsRedis;
			scope.defer(async () => {
				if (connection.status !== 'end') {
					await new Promise<void>(resolve => {
						connection.once('end', resolve);
						connection.disconnect();
					});
				}
			});
			await reactionsRedis.connect();
			await reactionsRedis.ping();
			if (cancelled) {
				throw timeout;
			}
		}

		let timelinesRedis = redis;
		if (config.redisForTimelines && config.redisForTimelines !== config.redis) {
			timelinesRedis = new Redis({
				...config.redisForTimelines, lazyConnect: true, retryStrategy: () => null,
				maxRetriesPerRequest: 0, disconnectTimeout: 0, connectTimeout: config.processes.startupTimeoutMs,
			});
			timelinesRedis.on('error', error => logger.error('timelines-redis.error', { error }));
			const connection = timelinesRedis;
			scope.defer(async () => {
				if (connection.status !== 'end') {
					await new Promise<void>(resolve => {
						connection.once('end', resolve);
						connection.disconnect();
					});
				}
			});
			await timelinesRedis.connect();
			await timelinesRedis.ping();
			if (cancelled) {
				throw timeout;
			}
		}
		timelinesRedis.on('end', () => {
			if (closing) {
				return;
			}
			if (active) {
				reportFailure(new DiagnosticError('TIMELINES_REDIS_ENDED', {}));
			} else {
				lostTimelines = true;
			}
		});

		const rolePublisher = new Redis({
			...config.redisForPubsub,
			disconnectTimeout: 0,
			lazyConnect: true,
			enableOfflineQueue: false,
			connectTimeout: config.processes.startupTimeoutMs,
			retryStrategy: () => null,
			maxRetriesPerRequest: 0,
		});
		rolePublisher.on('error', error => logger.error('role-pubsub.error', { error }));
		rolePublisher.on('end', () => {
			if (active && !closing) {
				// 再接続しない必須接続を失った子を残すと、Supervisorは障害を検知できない。
				reportFailure(new DiagnosticError('ROLE_PUBLISHER_ENDED', {}));
			}
		});
		scope.defer(async () => {
			if (rolePublisher.status !== 'end') {
				await new Promise<void>(resolve => {
					rolePublisher.once('end', resolve);
					rolePublisher.disconnect();
				});
			}
		});
		await rolePublisher.connect();
		await rolePublisher.ping();
		if (cancelled) {
			throw timeout;
		}

		const roleMaterials = await openRoleMaterials({
			source: createRoleMaterialReader(dataSource.manager),
			publisher: rolePublisher,
			subscriberConfig: { ...config.redisForPubsub, connectTimeout: config.processes.startupTimeoutMs },
			config: config.roleCache,
			registerCleanup: cleanup => scope.defer(cleanup),
		});
		if (cancelled) {
			await roleMaterials.close();
			throw timeout;
		}

		// 本家と同じくどの子も投入口を持つ。後続処理より先に登録し、後続処理の完了を待ってから閉じる。
		const pollEndedQueue = createPollEndedQueue({
			redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs, logger,
			onLost: onQueueLost(ENDED_POLL_NOTIFICATION),
		});
		scope.defer(pollEndedQueue.close);
		await pollEndedQueue.ready();
		if (cancelled) {
			throw timeout;
		}

		const deliverQueue = createDeliverQueue({
			redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs, logger,
			deliverJobMaxAttempts: config.deliverJob.deliverJobMaxAttempts,
			onLost: onQueueLost(DELIVER),
		});
		scope.defer(deliverQueue.close);
		await deliverQueue.ready();
		if (cancelled) {
			throw timeout;
		}

		const webhookQueue = createUserWebhookQueue({ redis: config.redisForJobQueue, connectTimeoutMs: config.processes.startupTimeoutMs, logger, onLost: onQueueLost(USER_WEBHOOK_DELIVER) });
		scope.defer(webhookQueue.close);
		await webhookQueue.ready();
		const webhooks = await openUserWebhooks({ manager: dataSource.manager, redis: config.redisForPubsub, url: config.url, timeoutMs: config.processes.startupTimeoutMs, enqueue: webhookQueue.enqueue, registerCleanup: cleanup => scope.defer(cleanup) });
		if (cancelled) {
			await webhooks.close();
			throw timeout;
		}

		const outboundHttp = createOutboundHttpClient(config);
		scope.defer(outboundHttp.close);
		const federationKeys = createFederationKeys({ dataSource, redis, logger }, config);
		const deliverToRelays = createDeliverToRelays({
			readAcceptedRelays: createAcceptedRelayReader({ manager: dataSource.manager, currentTime: Date.now }),
			attachLdSignature: async (activity, author) => {
				const key = await federationKeys.readUserKeypair(author.id);
				return signRsaSignature2017(activity, { privateKeyPem: key.privateKeyPem, creator: `${config.url}/users/${author.id}#main-key` }, new Date(), randomBytes(16).toString('hex'));
			},
			enqueue: deliverQueue.deliverOne,
		});
		const recipients = createDeliveryRecipientReader(dataSource.manager);
		const postingSearch = createPostingSearch(dataSource.manager, config, logger);
		scope.defer(postingSearch.close);
		const postingStream = createPostingStream(rolePublisher, config.url);
		const timelineCache = createTimelineCache(timelinesRedis, { createdAtFromId: createIdCodec(config.id).createdAtFromId, currentTime: Date.now, random: () => Math.random() });
		const postingNotifications = createPostingNotifications({
			dataSource, reactionsRedis, postingStream, webhook: webhooks.enqueue,
			roleTimelines: createPostingRoleTimelines({
				readRoleIds: createRoleTimelineReader(dataSource.manager, roleMaterials, createIdCodec(config.id).createdAtFromId).roleIds,
				cache: timelineCache, publish: postingStream.role, currentTime: Date.now,
			}),
		}, config);
		const antennaReader = createNoteAntennaReader(dataSource.manager);
		const antennas = await openNoteAntennas({
			reader: antennaReader, redis, subscriberConfig: config.redisForPubsub, url: config.url,
			timeoutMs: config.processes.startupTimeoutMs, currentTime: Date.now,
			onError: error => logger.error('note-antennas.cache-failed', { error }),
			registerCleanup: cleanup => scope.defer(cleanup),
		});
		if (cancelled) {
			await antennas.close();
			throw timeout;
		}
		const instanceLedger = createInstanceLedger({ manager: dataSource.manager, redis, newId: createIdCodec(config.id).newId });
		const noteInstanceCounts = createNoteInstanceCounts({
			enabled: async () => (await readMeta(dataSource.manager)).enableStatsForFederatedInstances,
			fetchOrRegister: instanceLedger.fetchOrRegisterInstance,
			increment: async (id, amount) => {
				await dataSource.getRepository(MiInstance).increment({ id }, 'notesCount', amount);
			},
			decrement: async id => {
				await dataSource.getRepository(MiInstance).decrement({ id }, 'notesCount', 1);
			},
			delayMs: process.env.NODE_ENV === 'test' ? 0 : 300000,
			onError: (error, details) => logger.error('note-instance-counts.failed', { error, ...details }),
		});
		scope.defer(noteInstanceCounts.close);
		const notePostSave = createNotePostSave(createNotePostSaveWork({
			instances: input => noteInstanceCounts.created(input.createdSnapshot?.author?.host ?? null),
			counts: createNotePostSaveCounts(dataSource.manager),
			hashtags: createPostingHashtags({
				mention: createNoteHashtagWriter(dataSource.manager, () => createIdCodec(config.id).newId(Date.now())).mention,
				ranking: createHashtagRanking(redis, Date.now),
				readSettings: () => readHashtagRankingSettings(dataSource.manager),
			}),
			featured: createPostingFeatured({
				add: createFeaturedRanking(redis, Date.now).add,
				currentTime: Date.now, random: () => Math.random(), createdAtFromId: createIdCodec(config.id).createdAtFromId,
			}),
			timelines: createPostingTimelines({
				reader: createNoteTimelineReader(dataSource.manager, config.perChannelMaxNoteCacheCount ?? 1000),
				cache: timelineCache,
				currentTime: Date.now, random: () => Math.random(),
			}),
			antennas: createPostingAntennas({ ...antennas, listContains: antennaReader.listContains, fullApAccount: createHostRules(new URL(config.url).host).fullApAccount, cache: timelineCache, publish: postingStream.antenna }),
			schedulePollEnded: pollEndedQueue.schedule,
			// 本家と同じく投稿を受けた子で表現と宛先を決め、送信は worker の子に任せる。
			deliver: postingNotifications.createdEvents(createDeliverCreatedNote({
				readNote: createNoteActivityReader(dataSource.manager, { ...config.noteMedia, url: config.url, createdAtFromId: createIdCodec(config.id).createdAtFromId }),
				readUsers: recipients.readUsers,
				readFollowerInboxes: recipients.readFollowerInboxes,
				enqueue: deliverQueue.deliverMany,
				deliverToRelays,
				selfUrl: config.url,
				currentTime: Date.now,
			}), postingSearch.index),
			currentTime: Date.now,
		}), logger);
		scope.defer(notePostSave.close);
		const deliverDeletedNote = createDeliverDeletedNote({
			readFollowerInboxes: recipients.readFollowerInboxes,
			readConcernedUsers: (snapshot: import('../modules/note/public.js').DeletedNoteSnapshot) => readDeletionConcernedUsers(dataSource.manager, snapshot),
			deliverToRelays,
			enqueue: deliverQueue.deliverMany,
		});
		const notePostDelete = createNotePostDelete(input => input.kind === 'instanceCounts'
			? noteInstanceCounts.deleted(input.snapshot.authorHost)
			: input.kind === 'search'
				? postingSearch.unindex(input.snapshot.note)
				: input.kind === 'stream'
					? postingStream.deleted({ id: input.snapshot.id, userId: input.snapshot.userId, visibility: input.snapshot.note.visibility, visibleUserIds: input.snapshot.auditNote.visibleUserIds as string[] }, input.occurredAtMs)
					: input.kind === 'delivery'
						? deliverDeletedNote(input)
						: appendNoteDeleteAudit(dataSource.manager, input, createIdCodec(config.id).newId), logger);
		scope.defer(notePostDelete.close);

		if (lostQueue !== undefined) {
			throw new DiagnosticError('JOB_QUEUE_REDIS_ENDED', { queue: lostQueue });
		}
		if (lostTimelines || timelinesRedis.status !== 'ready') {
			throw new DiagnosticError('TIMELINES_REDIS_ENDED', {});
		}
		active = true;
		return { dataSource, redis, reactionsRedis, timelinesRedis, roleMaterials, notePostSave, notePostDelete, postingNotifications, postingStream, noteAntennas: antennas, noteInstanceCounts, federationKeys, outboundHttp, logger, close, failure };
	};

	try {
		// Redis の connectTimeout は TCP 接続後の応答待ちを覆わないため、それだけには頼らない。
		return await Promise.race([
			initialize(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					cancelled = true;
					reject(timeout);
				}, config.processes.startupTimeoutMs);
			}),
		]);
	} catch (error) {
		cancelled = true;
		try {
			await close();
		} catch (cleanupError) {
			logger.error('cleanup.failed', { error: cleanupError });
		}

		throw error;
	} finally {
		clearTimeout(timer);
	}
}
