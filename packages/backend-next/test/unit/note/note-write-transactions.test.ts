/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { MiNote, MiPoll } from 'backend-upstream/entities';
import { createNoteWriter, createNoteWriteTransactions } from '../../../src/platform/database/note-writer.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { NewNote, NewPoll, NoteWrites } from '../../../src/modules/note/public.js';

const note: NewNote = {
	id: 'note', userId: 'author', userHost: null, text: 'hello @remote@example.test', cw: null,
	visibility: 'public', localOnly: false, reactionAcceptance: null, channelId: null,
	fileIds: ['file'], attachedFileTypes: ['image/png'], hasPoll: true,
	replyId: null, renoteId: null, threadId: null, replyUserId: null, replyUserHost: null,
	renoteUserId: null, renoteUserHost: null, renoteChannelId: null, visibleUserIds: [],
	mentions: ['remote'], mentionedRemoteUsers: [{ uri: 'https://example.test/users/remote', username: 'remote', host: 'example.test' }],
	tags: ['tag'], emojis: ['emoji'],
};
const poll: NewPoll = {
	noteId: 'note', choices: ['yes', 'no'], multiple: false, expiresAtMs: 1800000000000,
	votes: [0, 0], noteVisibility: 'public', userId: 'author', userHost: null, channelId: null,
};

function database() {
	const insertNote = vi.fn(async (row: MiNote) => {
		// Simulate TypeORM applying RETURNING defaults to the inserted entity.
		row.repliesCount = 0;
	});
	const insertPoll = vi.fn(async (_row: Partial<MiPoll>) => {});
	const getRepository = vi.fn((entity: unknown) => {
		if (entity === MiNote) {
			return { insert: insertNote };
		}
		if (entity === MiPoll) {
			return { insert: insertPoll };
		}
		throw new Error('unexpected repository');
	});
	return { manager: { getRepository } as unknown as EntityManager, getRepository, insertNote, insertPoll };
}

function dataSource() {
	const root = database();
	const tx = database();
	const transaction = vi.fn(async (work: (manager: EntityManager) => Promise<unknown>) => work(tx.manager));
	const source = { manager: root.manager, transaction } as unknown as DataSource;
	return { source, root, tx, transaction };
}

test.each([
	{ expiresAtMs: 1800000000000, expiresAt: new Date('2027-01-15T08:00:00.000Z') },
	{ expiresAtMs: null, expiresAt: null },
])('binds Note and Poll writes to the transaction manager (expiresAtMs: $expiresAtMs)', async ({ expiresAtMs, expiresAt }) => {
	const { source, root, tx, transaction } = dataSource();
	const raw = await createNoteWriteTransactions(source).run(async writes => {
		const snapshot = await writes.insertNote(note);
		await writes.insertPoll({ ...poll, expiresAtMs });
		return snapshot;
	});
	expect(transaction).toHaveBeenCalledTimes(1);
	expect(root.getRepository).not.toHaveBeenCalled();
	expect(root.insertNote).not.toHaveBeenCalled();
	expect(root.insertPoll).not.toHaveBeenCalled();
	expect(tx.getRepository.mock.calls).toEqual([[MiNote], [MiPoll]]);
	expect(tx.insertNote).toHaveBeenCalledTimes(1);
	const inserted = tx.insertNote.mock.calls[0]![0];
	expect(inserted).toBeInstanceOf(MiNote);
	expect(raw).toMatchObject({
		id: 'note', userId: 'author', text: 'hello @remote@example.test', hasPoll: true,
		fileIds: ['file'], attachedFileTypes: ['image/png'], mentions: ['remote'], tags: ['tag'], emojis: ['emoji'],
		mentionedRemoteUsers: '[{"uri":"https://example.test/users/remote","username":"remote","host":"example.test"}]',
		repliesCount: 0,
	});
	expect(raw).not.toBe(inserted);
	inserted.text = 'changed after insert';
	expect(raw).toHaveProperty('text', 'hello @remote@example.test');
	expect(tx.insertPoll).toHaveBeenCalledExactlyOnceWith({
		noteId: 'note', choices: ['yes', 'no'], multiple: false, expiresAt,
		votes: [0, 0], noteVisibility: 'public', userId: 'author', userHost: null, channelId: null,
	});
});

test.each(
	(['success', 'callback rejection'] as const).flatMap(outcome => (['insertNote', 'insertPoll'] as const).map(operation => ({ outcome, operation }))),
)('rejects escaped $operation before repository access after $outcome', async ({ outcome, operation }) => {
	const { source, root, tx } = dataSource();
	const failure = new Error('business rejected');
	let escaped!: NoteWrites;
	const pending = createNoteWriteTransactions(source).run(async writes => {
		escaped = writes;
		if (outcome === 'callback rejection') {
			throw failure;
		}
	});
	if (outcome === 'callback rejection') {
		await expect(pending).rejects.toBe(failure);
	} else {
		await pending;
	}
	const operations = {
		insertNote: () => escaped.insertNote(note),
		insertPoll: () => escaped.insertPoll(poll),
	};
	await expect(operations[operation]()).rejects.toThrow(/transaction has ended/i);
	for (const access of [root, tx]) {
		expect(access.getRepository).not.toHaveBeenCalled();
		expect(access.insertNote).not.toHaveBeenCalled();
		expect(access.insertPoll).not.toHaveBeenCalled();
	}
});

test('ordinary Note writes remain usable without opening a transaction', async () => {
	const { source, root, tx, transaction } = dataSource();
	const roles = { readRoles: vi.fn(), readAssignments: vi.fn() };
	const writer = createNoteWriter(source.manager, roles, () => 0);
	const raw = await writer.writes.insertNote({ ...note, mentions: [], mentionedRemoteUsers: [] });
	expect(raw).toMatchObject({ id: 'note', text: 'hello @remote@example.test', repliesCount: 0 });
	expect(raw).toHaveProperty('mentionedRemoteUsers', undefined);
	expect(root.getRepository).toHaveBeenCalledExactlyOnceWith(MiNote);
	expect(root.insertNote).toHaveBeenCalledTimes(1);
	expect(tx.getRepository).not.toHaveBeenCalled();
	expect(transaction).not.toHaveBeenCalled();
});
