/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiNote, MiUser } from 'backend-upstream/entities';
import type { DataSource, EntityManager } from 'typeorm';
import { WorkCapacityExceeded } from '../../src/modules/post-work/public.js';
import type { ApWorkRequest, NotificationWorkRequest } from '../../src/modules/post-work/public.js';
import { workCapacity } from '../../src/modules/post-work/prepare.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { PostWorkDispatchStore } from '../../src/platform/database/post-work/dispatch.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiUser).insert({ id: 'actor', username: 'actor', usernameLower: 'actor' });
});

beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.ap_host_lease, backend_internal.delivery_recipient, backend_internal.notification, backend_internal.notification_effect, backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.getRepository(MiNote).deleteAll();
	await source.getRepository(MiUser).update({ id: 'actor' }, { notesCount: 0 });
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows = 3, reserved_bytes = charged_bytes + 4096');
	await source.query('UPDATE backend_internal.work_control SET reserved_dispatches = 0');
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

// This is a producer fixture for #124, not the posting UseCase or an AP renderer.
async function insertNote(manager: EntityManager, suffix = '') {
	const [{ now }] = await manager.query('SELECT clock_timestamp() AS now') as { now: Date }[];
	const note = new MiNote({
		id: `note${suffix}`, userId: 'actor', text: '投稿本文「hello」',
		visibility: 'public', localOnly: false, channelId: null,
	});
	await manager.getRepository(MiNote).insert(note);
	await manager.getRepository(MiUser).increment({ id: note.userId }, 'notesCount', 1);
	const common = {
		eventId: `event${suffix}`, noteId: note.id, actorId: note.userId,
		note: { visibility: note.visibility, localOnly: note.localOnly, channelId: note.channelId },
		noteGeneration: 1 as const, schemaVersion: 1 as const, occurredAtMs: now.getTime(), notBeforeMs: now.getTime(),
	};
	const activityId = `https://example.test/activities/create${suffix}`;
	const ap: ApWorkRequest = {
		...common, requestId: `ap${suffix}`, kind: 'ap.expand',
		payload: {
			activity: { id: activityId, type: 'Create', body: JSON.stringify({ id: activityId, type: 'Create', object: { content: note.text } }) },
			directActorIds: [],
		},
	};
	const notification: NotificationWorkRequest = {
		...common, requestId: `notification${suffix}`, kind: 'notification.create',
		payload: { candidates: [{ recipientId: 'recipient', type: 'mention' }] },
	};
	return { note, ap, notification };
}

async function savePost(manager: EntityManager, suffix = '') {
	return withPostWorkRequests(manager, async requests => {
		const post = await insertNote(manager, suffix);
		await requests.append(post.ap);
		await requests.append(post.notification);
		return post;
	});
}

const capacity = () => source.query('SELECT reserved_rows, reserved_bytes FROM backend_internal.work_capacity');

async function expectNoPost() {
	expect(await source.getRepository(MiNote).count()).toBe(0);
	expect((await source.getRepository(MiUser).findOneByOrFail({ id: 'actor' })).notesCount).toBe(0);
	for (const table of ['work_request', 'work_item', 'note_work_state', 'queue_dispatch']) {
		expect(await source.query(`SELECT count(*)::int AS count FROM backend_internal.${table}`)).toEqual([{ count: 0 }]);
	}
}

test('commits the real upstream Note and both kinds of work with their fixed posting facts', async () => {
	await source.transaction(manager => savePost(manager));
	const note = await source.getRepository(MiNote).findOneByOrFail({ id: 'note' });
	expect(note).toMatchObject({
		id: 'note', userId: 'actor', text: '投稿本文「hello」', visibility: 'public', localOnly: false, channelId: null,
		uri: null, fileIds: [], visibleUserIds: [], reactions: {}, hasPoll: false,
	});
	expect((await source.getRepository(MiUser).findOneByOrFail({ id: 'actor' })).notesCount).toBe(1);
	expect(await source.query('SELECT request_id, event_id, note_id, actor_id, note_generation, note_facts FROM backend_internal.work_request ORDER BY request_id')).toEqual([
		{ request_id: 'ap', event_id: 'event', note_id: 'note', actor_id: 'actor', note_generation: 1, note_facts: { visibility: 'public', localOnly: false, channelId: null } },
		{ request_id: 'notification', event_id: 'event', note_id: 'note', actor_id: 'actor', note_generation: 1, note_facts: { visibility: 'public', localOnly: false, channelId: null } },
	]);
	expect(await source.query('SELECT kind, state, attempt_count FROM backend_internal.work_item ORDER BY kind')).toEqual([
		{ kind: 'ap.expand', state: 'ready', attempt_count: 0 },
		{ kind: 'notification.create', state: 'ready', attempt_count: 0 },
	]);
	expect(await source.query('SELECT generation, create_event_id, recipient_coverage FROM backend_internal.note_work_state')).toEqual([
		{ generation: 1, create_event_id: 'event', recipient_coverage: 'not_started' },
	]);
});

test('rolls back the real Note and all appended work when the posting transaction fails', async () => {
	const before = await capacity();
	await expect(source.transaction(async manager => {
		await savePost(manager);
		throw new Error('posting failed before commit');
	})).rejects.toThrow('posting failed before commit');
	await expectNoPost();
	expect(await capacity()).toEqual(before);
});

test('rolls back the Note and earlier AP work if notification capacity cannot be reserved', async () => {
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows = $1', [workCapacity.rows * 0.9 - 4]);
	const before = await capacity();
	await expect(source.transaction(manager => withPostWorkRequests(manager, async requests => {
		const post = await insertNote(manager);
		await requests.append(post.ap);
		expect(await manager.query('SELECT kind FROM backend_internal.work_request')).toEqual([{ kind: 'ap.expand' }]);
		await requests.append(post.notification);
	}))).rejects.toBeInstanceOf(WorkCapacityExceeded);
	await expectNoPost();
	expect(await capacity()).toEqual(before);
});

test('rolls back appended work when a subsequent upstream Note constraint fails', async () => {
	const before = await capacity();
	await expect(source.transaction(async manager => {
		await savePost(manager);
		await manager.getRepository(MiNote).update({ id: 'note' }, { channelId: 'missing-channel' });
	})).rejects.toMatchObject({ driverError: { code: '23503' } });
	await expectNoPost();
	expect(await capacity()).toEqual(before);
});

test('keeps the Note and work invisible to another connection until the common commit', async () => {
	const runner = source.createQueryRunner();
	const observer = await createDataSource(database.config.database).initialize();
	await runner.connect();
	await runner.startTransaction();
	try {
		await savePost(runner.manager);
		expect(await observer.getRepository(MiNote).count()).toBe(0);
		expect(await observer.query('SELECT request_id FROM backend_internal.work_request')).toEqual([]);
		expect(await new PostWorkDispatchStore(observer).claim('before-commit')).toEqual({ status: 'empty' });
		await runner.commitTransaction();
		expect(await observer.getRepository(MiNote).count()).toBe(1);
		expect(await observer.query('SELECT request_id FROM backend_internal.work_request ORDER BY request_id')).toEqual([
			{ request_id: 'ap' }, { request_id: 'notification' },
		]);
	} finally {
		if (runner.isTransactionActive) {
			await runner.rollbackTransaction();
		}
		await runner.release();
		await observer.destroy();
	}
});

test('finds committed posting work through the real dispatch claim after reconnecting without an enqueue', async () => {
	await source.transaction(manager => savePost(manager));
	await source.destroy();
	source = await createDataSource(database.config.database).initialize();
	const store = new PostWorkDispatchStore(source);
	const claims = [await store.claim('restarted-producer'), await store.claim('restarted-producer')];
	expect(claims.every(claim => claim.status === 'claimed')).toBe(true);
	expect(claims.flatMap(claim => claim.status === 'claimed' ? [claim.reservation.kind] : []).sort()).toEqual(['ap.expand', 'notification.create']);
	expect(await store.claim('restarted-producer')).toEqual({ status: 'empty' });
	expect(await source.getRepository(MiNote).count()).toBe(1);
	expect(await source.query('SELECT attempt_count, dispatch_seq FROM backend_internal.work_item')).toEqual([
		{ attempt_count: 0, dispatch_seq: '1' }, { attempt_count: 0, dispatch_seq: '1' },
	]);
});
