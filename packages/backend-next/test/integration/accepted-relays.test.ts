/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiRelay } from 'backend-upstream/entities';
import { createAcceptedRelayReader } from '../../src/platform/database/accepted-relays.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let now = 0;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
});
beforeEach(async () => {
	now = 0;
	await source.getRepository(MiRelay).clear();
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

function reader() {
	return createAcceptedRelayReader({ manager: source.manager, currentTime: () => now });
}

test('only accepted rows in DB-returned order; mutation remains stale through exactly ten minutes', async () => {
	const repository = source.getRepository(MiRelay);
	await repository.insert([{ id: 'c', inbox: 'https://c.test', status: 'accepted' }, { id: 'a', inbox: 'https://a.test', status: 'accepted' }, { id: 'r', inbox: 'https://r.test', status: 'requesting' }, { id: 'x', inbox: 'https://x.test', status: 'rejected' }]);
	const expected = await repository.findBy({ status: 'accepted' });
	const read = reader();
	expect(await read()).toEqual(expected);
	await repository.update({ id: 'c' }, { status: 'rejected' });
	now = 600000;
	expect(await read()).toEqual(expected);
	now++;
	expect(await read()).toEqual(await repository.findBy({ status: 'accepted' }));
});

test('empty results are cached', async () => {
	const read = reader();
	expect(await read()).toEqual([]);
	await source.getRepository(MiRelay).insert({ id: 'a', inbox: 'https://a.test', status: 'accepted' });
	now = 600000;
	expect(await read()).toEqual([]);
	now++;
	expect(await read()).toMatchObject([{ inbox: 'https://a.test' }]);
});

test('timestamp follows successful retrieval, failed reads retry, simultaneous misses do not coalesce', async () => {
	const repo = source.manager.getRepository(MiRelay);
	const original = repo.findBy.bind(repo);
	let release!: () => void;
	const blocked = new Promise<void>(resolve => {
		release = resolve;
	});
	const find = vi.spyOn(repo, 'findBy').mockRejectedValueOnce(new Error('unavailable')).mockImplementation(async where => {
		await blocked;
		return original(where);
	});
	try {
		const read = reader();
		await expect(read()).rejects.toThrow('unavailable');
		const first = read();
		const second = read();
		expect(find).toHaveBeenCalledTimes(3);
		now = 400000;
		release();
		await Promise.all([first, second]);
		await repo.insert({ id: 'a', inbox: 'https://a.test', status: 'accepted' });
		now = 1000000;
		expect(await read()).toEqual([]);
		now++;
		expect(await read()).toMatchObject([{ inbox: 'https://a.test' }]);
	} finally {
		find.mockRestore();
	}
});
