/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiDriveFile, MiEmoji, MiFollowing, MiMeta, MiNote, MiPoll, MiUser } from 'backend-upstream/entities';
import { createDeliverCreatedNote, renderNoteActivity } from '../../src/modules/federation/public.js';
import { createDeliveryRecipientReader } from '../../src/platform/database/delivery-recipients.js';
import { deliverJobs } from '../../src/platform/job-queue/deliver.js';
import type { DeliverBatch } from '../../src/modules/federation/public.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createNoteActivityReader } from '../../src/platform/database/note-activity.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';
import { deliveryFactsFor, loadApDeliverCases, withMentionTagsAsSet } from '../helpers/ap-deliver-cases.js';
import type { RenderCases } from '../helpers/ap-deliver-cases.js';
import type { DataSource } from 'typeorm';

const recorded = loadApDeliverCases<RenderCases>('render-cases.json');
const { inputs } = recorded;
const expected = new Map(recorded.cases.map(c => [c.id, c]));
const codec = createIdCodec('aidx');
const options = { selfUrl: inputs.selfUrl, now: Date.parse(inputs.now) };

// 配送の区画に入らない投稿（表現の対象外）と、DB の外部キーのため行として作れない投稿（作者のいない返信先）。後者は単体試験で比べる。
const skipped = new Set(['local-only', 'channel', 'remote-author', 'reply-author-missing']);
const cases = inputs.cases.filter(c => !skipped.has(c.id));
// どの case でも表現の前に消えている投稿は、最初から入れない。
const deleted = new Set(inputs.cases.flatMap(c => c.deletedBeforeRender));

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let read: ReturnType<typeof createNoteActivityReader>;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = createDataSource(database.config.database);
	await source.initialize();
	read = createNoteActivityReader(source.manager, { url: inputs.selfUrl, createdAtFromId: codec.createdAtFromId });

	// 本家の probe と同じ meta（期限切れのリモートファイルをローカルのプロキシで返す）。
	await source.getRepository(MiMeta).insert({ id: 'singleton', proxyRemoteFiles: true });
	for (const user of inputs.users) {
		await source.getRepository(MiUser).insert({
			id: user.id, username: user.username, usernameLower: user.username.toLowerCase(), host: user.host, uri: user.uri, inbox: user.inbox, sharedInbox: user.sharedInbox,
		});
	}
	for (const note of inputs.notes.filter(n => !deleted.has(n.id) && inputs.users.some(u => u.id === n.userId))) {
		await source.getRepository(MiNote).insert(note);
	}
	for (const { properties, ...file } of inputs.files) {
		await source.getRepository(MiDriveFile).insert({ ...file, properties, userId: 'alice', md5: '0'.repeat(32), name: `${file.id}.bin`, size: 1, storedInternal: false });
	}
	for (const [i, { updatedAt, ...emoji }] of inputs.emojis.entries()) {
		await source.getRepository(MiEmoji).insert({ ...emoji, id: `emoji${i}`, updatedAt: updatedAt === null ? null : new Date(updatedAt) });
	}
	for (const c of cases) {
		const { note } = c;
		// 本家と同じく、返信先・Renote 先の作者は保存時の値を列に写す。
		const { replyUserId, replyUserHost, renoteUserId, renoteUserHost } = deliveryFactsFor(inputs, c);
		await source.getRepository(MiNote).insert({ ...note, replyUserId, replyUserHost, renoteUserId, renoteUserHost });
		const poll = inputs.polls[note.id];
		if (note.hasPoll && poll) {
			await source.getRepository(MiPoll).insert({
				...poll, expiresAt: poll.expiresAt === null ? null : new Date(poll.expiresAt), noteVisibility: note.visibility, userId: note.userId, userHost: null, channelId: null,
			});
		}
	}
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test.for(cases)('$id read back from the database renders the same activity as the pinned upstream', async c => {
	const upstream = expected.get(c.id)!;

	const materials = await read(c.note.id);
	if (materials === null) {
		throw new Error(`note ${c.note.id} was not read`);
	}

	if (upstream.activity === null) {
		expect(() => renderNoteActivity(materials, options)).toThrow(expect.objectContaining({ message: upstream.unhandledRejections[0] }));
		return;
	}
	expect(withMentionTagsAsSet(JSON.stringify(renderNoteActivity(materials, options)))).toBe(withMentionTagsAsSet(upstream.activity));
});

test('mentioned users come back in the saved mentions order', async () => {
	const c = inputs.cases.find(x => x.id === 'public-mentions-db-order')!;

	const materials = await read(c.note.id);

	expect(materials?.mentionedUsers.map(user => user.id)).toEqual(c.note.mentions);
});

test('a note that no longer exists has no materials', async () => {
	expect(await read('missing-note')).toBeNull();
});

test('an expired remote file is linked through the local file proxy', async () => {
	const author = inputs.users.find(u => u.host === null)!;
	await source.getRepository(MiDriveFile).insert({
		id: 'file-expired', userId: author.id, md5: '0'.repeat(32), name: 'expired.png', type: 'image/png', size: 1, storedInternal: false, properties: {},
		url: 'https://remote1.example/files/expired.png', uri: 'https://remote1.example/files/expired.png', userHost: null, isLink: true, webpublicAccessKey: 'expired-key',
	});
	await source.getRepository(MiNote).insert({ id: 'with-expired-file', userId: author.id, visibility: 'public', fileIds: ['file-expired'] });

	const materials = await read('with-expired-file');

	expect(materials?.files.map(file => file.url)).toEqual([`${inputs.selfUrl}/files/expired-key`]);
});

test.for(cases)('$id read back from the database is queued to the same inboxes as the pinned upstream (relay excluded)', async c => {
	const upstream = expected.get(c.id)!;
	const followings = source.getRepository(MiFollowing);
	await followings.delete({ followeeId: c.note.userId });
	for (const [i, followerId] of c.followers.entries()) {
		const follower = inputs.users.find(u => u.id === followerId)!;
		await followings.insert({
			id: `following${i}`, followerId, followeeId: c.note.userId, followerHost: follower.host,
			followerInbox: follower.inbox, followerSharedInbox: follower.sharedInbox, followeeHost: null,
		});
	}
	const batches: DeliverBatch[] = [];
	const recipients = createDeliveryRecipientReader(source.manager);
	const deliver = createDeliverCreatedNote({
		readNote: read, readUsers: recipients.readUsers, readFollowerInboxes: recipients.readFollowerInboxes,
		enqueue: async batch => {
			batches.push(batch);
		},
		selfUrl: inputs.selfUrl, currentTime: () => options.now,
	});

	if (c.id === 'public-follower-without-inbox') {
		// 本家の probe は following の問い合わせを stub にした。実際の TypeORM は選んだ列がすべて null の行を返さないため、
		// 本家も新実装も inbox のないフォロワーを飛ばし、`inbox is null` にはならない。
		await deliver(c.note.id);
		const reachable = c.followers.map(id => inputs.users.find(u => u.id === id)!).filter(u => (u.sharedInbox ?? u.inbox) !== null);
		expect([...batches[0].inboxes]).toEqual(reachable.map(u => [u.sharedInbox ?? u.inbox, u.sharedInbox !== null]));
		return;
	}
	if (upstream.addBulk === null) {
		await expect(deliver(c.note.id)).rejects.toMatchObject({ name: 'NoteDeliveryError' });
		expect(batches).toEqual([]);
		return;
	}
	await deliver(c.note.id);
	expect(deliverJobs(batches[0], {}).map(job => ({ name: job.name, to: job.data.to, isSharedInbox: job.data.isSharedInbox }))).toEqual(upstream.addBulk.jobs);
});
