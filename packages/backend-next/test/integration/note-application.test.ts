/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiMeta, MiNote, MiPoll, MiUser } from 'backend-upstream/entities';
import { createNoteApplication } from '../../src/composition/note.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { RemoteUserPorts } from '../../src/modules/federation/public.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let observer: DataSource;
const codec = createIdCodec('aidx');
const now = Date.parse('2026-11-09T12:00:00Z');
const userId = codec.newId(now - 100000);
const actor = { userId, canWriteNote: true };
let noteId: string;
const unavailable = async (): Promise<never> => {
	throw new Error('unexpected remote access');
};
const remoteUsers: RemoteUserPorts = {
	selfHost: 'example.test', localId: () => null,
	readByAccount: unavailable, readByUri: unavailable, readLocal: unavailable,
	markAttempt: unavailable, repairUri: unavailable, webfinger: unavailable,
	acquireActor: unavailable, insertActor: unavailable, refreshActor: unavailable,
	actorTransactions: { run: unavailable },
};
const limit = vi.fn(async () => {});
const clock = vi.fn(() => now + 1000);
const afterSaved = vi.fn();
const newId = vi.fn(() => noteId);
const roleMaterials = { readRoles: vi.fn(async () => []), readAssignments: vi.fn(async () => []) };
const application = () => createNoteApplication({
	dataSource: source, roleMaterials, remoteUsers, limit, clock, afterSaved,
	ids: { newId, createdAtFromId: codec.createdAtFromId },
});
const pollInput = { text: 'poll', poll: { choices: ['a', 'b'], expiresAt: now + 10000 } };
const rows = async (db = observer) => [
	await db.getRepository(MiNote).countBy({ id: noteId }),
	await db.getRepository(MiPoll).countBy({ noteId }),
];

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	observer = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiMeta).insert({ id: 'singleton' });
	await source.getRepository(MiUser).insert({ id: userId, username: 'author', usernameLower: 'author' });
});
afterAll(async () => {
	await observer?.destroy();
	await source?.destroy();
	await database?.close();
});
beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	noteId = codec.newId(now);
});

test('constructs only createNote without owning resource lifecycle', () => {
	const initialize = vi.spyOn(source, 'initialize');
	const destroy = vi.spyOn(source, 'destroy');
	const transaction = vi.spyOn(source, 'transaction');
	expect(Object.keys(application())).toEqual(['createNote']);
	expect(initialize).not.toHaveBeenCalled();
	expect(destroy).not.toHaveBeenCalled();
	expect(transaction).not.toHaveBeenCalled();
});

test('creates a Note directly using injected dependencies', async () => {
	const transaction = vi.spyOn(source, 'transaction');
	const render = vi.fn(async (id: string, viewerId: string) => {
		expect(await rows()).toEqual([1, 0]);
		return { id, viewerId };
	});
	expect(await application().createNote(actor, { text: 'direct' }, now, render)).toEqual({ id: noteId, viewerId: userId });
	expect(transaction).not.toHaveBeenCalled();
	expect(newId).toHaveBeenCalledWith(now);
	expect(limit).toHaveBeenCalledWith(userId, 1);
	expect(roleMaterials.readAssignments).toHaveBeenCalledWith(userId);
	expect(afterSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ noteId, userId, pollExpiresAtMs: null, createdSnapshot: expect.objectContaining({ note: expect.objectContaining({ id: noteId, text: 'direct' }) }) }));
	// Expiry uses the injected clock after related reads, rather than request time.
	await expect(application().createNote(actor, { poll: { choices: ['a', 'b'], expiresAt: now + 500 } }, now, render)).rejects.toMatchObject({ code: 'CANNOT_CREATE_ALREADY_EXPIRED_POLL' });
	expect(clock).toHaveBeenCalledOnce();
	expect(await rows()).toEqual([1, 0]);
});

// Wrap the real transaction callback after both inserts, retaining its commit/rollback behavior.
function interceptTransaction(afterWork: (manager: EntityManager) => Promise<void>) {
	const transaction = source.transaction.bind(source);
	return vi.spyOn(source, 'transaction').mockImplementation(async (work: unknown) => transaction(async manager => {
		const result = await (work as (manager: EntityManager) => Promise<unknown>)(manager);
		await afterWork(manager);
		return result;
	}));
}

test('commits a Note and Poll together', async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	const transaction = interceptTransaction(async manager => {
		expect(await manager.getRepository(MiNote).countBy({ id: noteId })).toBe(1);
		expect(await manager.getRepository(MiPoll).countBy({ noteId })).toBe(1);
		entered.resolve();
		await release.promise;
	});
	const render = vi.fn(async () => {
		expect(await rows()).toEqual([1, 1]);
		return 'rendered';
	});
	const pending = application().createNote(actor, pollInput, now, render);
	try {
		await Promise.race([entered.promise, pending.then(() => {
			throw new Error('barrier was not reached');
		})]);
		expect(await rows()).toEqual([0, 0]);
		expect(render).not.toHaveBeenCalled();
		expect(afterSaved).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await pending;
	}
	expect(transaction).toHaveBeenCalledOnce();
	expect(render).toHaveBeenCalledOnce();
	expect(clock).toHaveBeenCalledOnce();
});

test('rolls both rows back when work rejects after both inserts', async () => {
	const failure = new Error('reject after both inserts');
	interceptTransaction(async manager => {
		expect(await manager.getRepository(MiNote).countBy({ id: noteId })).toBe(1);
		expect(await manager.getRepository(MiPoll).countBy({ noteId })).toBe(1);
		throw failure;
	});
	const render = vi.fn(async () => 'unexpected');
	await expect(application().createNote(actor, pollInput, now, render)).rejects.toBe(failure);
	expect(await rows()).toEqual([0, 0]);
	expect(render).not.toHaveBeenCalled();
	expect(afterSaved).not.toHaveBeenCalled();
});

test.each([false, true].flatMap(poll => [false, true].map(reject => ({ poll, reject }))))('starts successors after rendering settles for poll=$poll reject=$reject', async ({ poll, reject }) => {
	const rendering = deferred<string>();
	const entered = deferred<void>();
	const failure = new Error('response render failed');
	const pending = application().createNote(actor, poll ? pollInput : { text: 'plain' }, now, async () => {
		expect(await rows()).toEqual([1, poll ? 1 : 0]);
		entered.resolve();
		return rendering.promise;
	});
	const settled = reject ? expect(pending).rejects.toBe(failure) : expect(pending).resolves.toBe('rendered');
	try {
		await Promise.race([entered.promise, pending]);
		expect(afterSaved).not.toHaveBeenCalled();
	} finally {
		if (reject) {
			rendering.reject(failure);
		} else {
			rendering.resolve('rendered');
		}
		await settled;
	}
	expect(afterSaved).toHaveBeenCalledOnce();
	expect(afterSaved).toHaveBeenCalledWith(expect.objectContaining({ noteId, pollExpiresAtMs: poll ? now + 10000 : null }));
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes; reject = no;
	});
	return { promise, resolve, reject };
}
