/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { RoleMaterialCache } from '../../../src/platform/role-material-cache.js';
import { assignment, deferred, role } from './fixtures.js';

function fixture(maxEntries = 2) {
	let now = 0;
	const source = {
		readRoles: vi.fn(async () => [role()]),
		readAssignments: vi.fn(async (userId: string) => [assignment({ userId })]),
	};
	const cache = new RoleMaterialCache(source, { rolesTtlMs: 100, assignmentsTtlMs: 50, assignmentsMaxEntries: maxEntries }, () => now);
	return {
		source, cache,
		time: (value: number) => {
			now = value;
		},
	};
}

test('starts TTL at DB read start, without extending on access or slow completion', async () => {
	const { source, cache, time } = fixture();
	const pending = deferred<ReturnType<typeof role>[]>();
	source.readRoles.mockReturnValueOnce(pending.promise);
	const first = cache.readRoles();
	time(80);
	pending.resolve([role()]);
	await first;
	time(99);
	await cache.readRoles();
	expect(source.readRoles).toHaveBeenCalledTimes(1);
	time(100);
	await cache.readRoles();
	expect(source.readRoles).toHaveBeenCalledTimes(2);

	cache.clear();
	const slow = deferred<ReturnType<typeof role>[]>();
	source.readRoles.mockReturnValueOnce(slow.promise);
	const read = cache.readRoles();
	time(250);
	slow.resolve([role()]);
	await read;
	await cache.readRoles();
	expect(source.readRoles).toHaveBeenCalledTimes(4);
});

test('coalesces concurrent reads and isolates mutations of returned materials', async () => {
	const { source, cache } = fixture();
	const [a, b] = await Promise.all([cache.readRoles(), cache.readRoles()]);
	a[0].policies = { changed: true };
	expect(b[0].policies).toEqual({});
	expect((await cache.readRoles())[0].policies).toEqual({});
	expect(source.readRoles).toHaveBeenCalledTimes(1);
	const assigned = await cache.readAssignments('a');
	assigned[0].roleId = 'other';
	expect((await cache.readAssignments('a'))[0].roleId).toBe('manual');
});

test('bounds assignment entries with LRU without refreshing TTL and isolates users', async () => {
	const { source, cache, time } = fixture();
	await cache.readAssignments('a');
	await cache.readAssignments('b');
	time(40);
	await cache.readAssignments('a');
	await cache.readAssignments('c');
	await cache.readAssignments('a');
	expect(source.readAssignments).toHaveBeenCalledTimes(3);
	await cache.readAssignments('b');
	expect(source.readAssignments).toHaveBeenCalledTimes(4);
	time(50);
	await cache.readAssignments('a');
	expect(source.readAssignments).toHaveBeenCalledTimes(5);
});

test.each(['success', 'failure'] as const)('old invalidated read %s cannot replace/delete a newer entry', async outcome => {
	const { source, cache } = fixture();
	const old = deferred<ReturnType<typeof role>[]>();
	source.readRoles.mockReturnValueOnce(old.promise);
	const oldRead = cache.readRoles();
	const settled = oldRead.catch(error => error);
	cache.invalidateRoles();
	source.readRoles.mockResolvedValue([role({ id: 'new' })]);
	await cache.readRoles();
	if (outcome === 'success') {
		old.resolve([role({ id: 'old' })]);
	} else {
		old.reject(new Error('old failure'));
	}
	await settled;
	expect((await cache.readRoles())[0].id).toBe('new');
	expect(source.readRoles).toHaveBeenCalledTimes(2);
});

test('bounds in-flight assignments and does not resurrect evicted reads', async () => {
	const { source, cache } = fixture(1);
	const old = deferred<ReturnType<typeof assignment>[]>();
	source.readAssignments.mockReturnValueOnce(old.promise);
	const read = cache.readAssignments('a');
	await cache.readAssignments('b');
	old.resolve([assignment({ roleId: 'stale' })]);
	await read;
	expect((await cache.readAssignments('a'))[0].roleId).toBe('manual');
	expect(source.readAssignments).toHaveBeenCalledTimes(3);
});

test('clear invalidates both material families including pending reads', async () => {
	const { source, cache } = fixture();
	const old = deferred<ReturnType<typeof assignment>[]>();
	source.readAssignments.mockReturnValueOnce(old.promise);
	const read = cache.readAssignments('a');
	await cache.readRoles();
	cache.clear();
	old.resolve([assignment()]);
	await read;
	await cache.readAssignments('a');
	await cache.readRoles();
	expect(source.readAssignments).toHaveBeenCalledTimes(2);
	expect(source.readRoles).toHaveBeenCalledTimes(2);
});

test('failed reads are not cached', async () => {
	const { source, cache } = fixture();
	source.readRoles.mockRejectedValueOnce(new Error('database failure'));
	await expect(cache.readRoles()).rejects.toThrow('database failure');
	await cache.readRoles();
	expect(source.readRoles).toHaveBeenCalledTimes(2);
});
