/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createFederationKeys } from '../composition/federation-keys.js';
import { createDeliverCreatedNote, createDeliverToRelays, createDeliverDeletedNote } from '../modules/federation/public.js';
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
		const notePostSave = createNotePostSave(createNotePostSaveWork({
			counts: createNotePostSaveCounts(dataSource.manager),
			schedulePollEnded: pollEndedQueue.schedule,
			// 本家と同じく投稿を受けた子で表現と宛先を決め、送信は worker の子に任せる。
			deliver: createDeliverCreatedNote({
				readNote: createNoteActivityReader(dataSource.manager, { ...config.noteMedia, url: config.url, createdAtFromId: createIdCodec(config.id).createdAtFromId }),
				readUsers: recipients.readUsers,
				readFollowerInboxes: recipients.readFollowerInboxes,
				enqueue: deliverQueue.deliverMany,
				deliverToRelays,
				selfUrl: config.url,
				currentTime: Date.now,
			}),
			currentTime: Date.now,
		}), logger);
		scope.defer(notePostSave.close);
		const deliverDeletedNote = createDeliverDeletedNote({
			readFollowerInboxes: recipients.readFollowerInboxes,
			readConcernedUsers: (snapshot: import('../modules/note/public.js').DeletedNoteSnapshot) => readDeletionConcernedUsers(dataSource.manager, snapshot),
			deliverToRelays,
			enqueue: deliverQueue.deliverMany,
		});
		const notePostDelete = createNotePostDelete(input => input.kind === 'delivery'
			? deliverDeletedNote(input)
			: appendNoteDeleteAudit(dataSource.manager, input, createIdCodec(config.id).newId), logger);
		scope.defer(notePostDelete.close);

		if (lostQueue !== undefined) {
			throw new DiagnosticError('JOB_QUEUE_REDIS_ENDED', { queue: lostQueue });
		}
		active = true;
		return { dataSource, redis, reactionsRedis, roleMaterials, notePostSave, notePostDelete, federationKeys, logger, close, failure };
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
