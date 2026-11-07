/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createPostingRoleTimelines } from '../../../src/composition/posting-role-timelines.js';
import { createTimelineCache } from '../../../src/platform/timeline-cache.js';
import { createPostingStream } from '../../../src/platform/posting-stream.js';
import { selectApplicableRoles, selectAssignedRoles } from '../../../src/modules/role/public.js';
import type { EvaluationRole } from '../../../src/modules/role/public.js';
import { user, deferred } from '../role/fixtures.js';

function setup(roleIds: string[], options: { rejectedRole?: string; direct?: Promise<string | null>; publication?: Promise<void>; readFailure?: boolean } = {}) {
	const events: unknown[] = [];
	const cache = createTimelineCache({
		pipeline: () => {
			events.push('begin');
			return {
				lpush: (key: string, note: string) => events.push(['push', key, note]),
				ltrim: (key: string, start: number, end: number) => events.push(['trim', key, start, end]),
				exec: async () => {
					events.push('exec');
					return [];
				},
			};
		},
		lindex: async () => options.direct ?? null,
		lpush: async (key, note) => {
			events.push(['direct', key, note]);
			return 1;
		},
	}, { createdAtFromId: () => options.direct ? 0 : 1000000, currentTime: () => 1000000, random: () => 0 });
	const stream = createPostingStream({ publish: async (channel, value) => {
		const envelope = JSON.parse(value);
		events.push(['publication', channel, envelope]);
		if (envelope.channel === `roleTimelineStream:${options.rejectedRole}`) {
			throw new Error('publication');
		}
		await options.publication;
		return 1;
	} }, 'https://example.test:3000');
	const run = createPostingRoleTimelines({ readRoleIds: async (userId, now) => {
		events.push(['read', userId, now]);
		if (options.readFailure) {
			throw new Error('role material read');
		}
		return roleIds;
	}, cache, publish: stream.role, currentTime: () => 12345 });
	return { events, run };
}

test('role order and assigned conditional duplicates keep full packed publication and max1000', async () => {
	const world = setup(['manual', 'conditional', 'conditional']);
	const packed = { id: 'n', text: 'private', visibility: 'specified', user: { id: 'u' } };
	await world.run('n', 'u', packed);
	expect(world.events).toEqual([
		['read', 'u', 12345], 'begin',
		...['manual', 'conditional', 'conditional'].flatMap(roleId => [
			['push', `list:roleTimeline:${roleId}`, 'n'], ['trim', `list:roleTimeline:${roleId}`, 0, 999],
			['publication', 'example.test:3000', { channel: `roleTimelineStream:${roleId}`, message: { type: 'note', body: packed } }],
		]), 'exec',
	]);
});

test('empty roles still execute an empty batch after lookup', async () => {
	const world = setup([]);
	await world.run('n', 'u', {});
	expect(world.events).toEqual([['read', 'u', 12345], 'begin', 'exec']);
});

test('role lookup failure is not an empty successful batch', async () => {
	const world = setup([], { readFailure: true });
	await expect(world.run('n', 'u', {})).rejects.toThrow('role material read');
	expect(world.events).toEqual([['read', 'u', 12345]]);
});

test('rejected publication preserves later role publication and cache flush, and waits begun old writes', async () => {
	const gate = deferred<string | null>();
	const world = setup(['broken', 'later'], { rejectedRole: 'broken', direct: gate.promise });
	let done = false;
	const running = world.run('old', 'u', {}).catch(error => error).finally(() => {
		done = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(world.events).toContain('exec');
	expect(world.events.filter(event => Array.isArray(event) && event[0] === 'publication')).toHaveLength(2);
	expect(done).toBe(false);
	gate.resolve(null);
	expect(await running).toBeInstanceOf(AggregateError);
	expect(world.events.filter(event => Array.isArray(event) && event[0] === 'direct')).toEqual([
		['direct', 'list:roleTimeline:broken', 'old'], ['direct', 'list:roleTimeline:later', 'old'],
	]);
});

test('successful cache flush does not end drain before pending publication', async () => {
	const gate = deferred<void>();
	const world = setup(['slow'], { publication: gate.promise });
	let done = false;
	const running = world.run('n', 'u', {}).finally(() => {
		done = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(world.events).toContain('exec');
	expect(done).toBe(false);
	gate.resolve();
	await running;
});

test('synchronous preparation throw drains begun direct writes without flushing unsent batch or starting later roles', async () => {
	const gate = deferred<string | null>();
	const writes: string[] = [];
	const cache = createTimelineCache({
		pipeline: () => ({ lpush: () => {}, ltrim: () => {}, exec: async () => {
			writes.push('exec');
			return [];
		} }),
		lindex: async () => gate.promise,
		lpush: async key => {
			writes.push(key);
			return 1;
		},
	}, { createdAtFromId: () => 0, currentTime: () => 1000000, random: () => 0 });
	const run = createPostingRoleTimelines({ readRoleIds: async () => ['broken', 'later'], cache, currentTime: () => 1000000, publish: () => {
		throw new Error('synchronous publication');
	} });
	let ended = false;
	const running = run('old', 'u', {}).catch(error => error).finally(() => {
		ended = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(ended).toBe(false);
	gate.resolve(null);
	expect(await running).toBeInstanceOf(AggregateError);
	expect(writes).toEqual(['list:roleTimeline:broken']);
});

interface SourceCase {
	id: string;
	input: { roles: (EvaluationRole & { isPublic: boolean; isExplorable: boolean })[]; assignments: { id: string; userId: string; roleId: string; expiresAt: string | null }[] };
	calls: { method: string; roleId?: string }[];
}
const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/note/role-timeline/source-observations.json', import.meta.url), 'utf8')) as { observations: SourceCase[] };
const membershipCases = source.observations.filter(value => value.id.startsWith('membership-'));

test.each(membershipCases)('pinned original membership and producer effects: $id', async reference => {
	const now = 1700000000000;
	const roles = reference.input.roles;
	const assignments = reference.input.assignments.map(value => ({ ...value, expiresAtMs: value.expiresAt === null ? null : Date.parse(value.expiresAt) }));
	const facts = user({ userId: 'author', host: null, notesCount: 9, isSuspended: false, isLocked: false, isBot: false, isCat: false, isExplorable: false });
	const selected = selectApplicableRoles(roles, assignments, facts, now).map(value => value.id);
	const expected = reference.calls.filter(value => value.method === 'rolePublication').map(value => value.roleId);
	expect(selected).toEqual(expected);
	if (!roles.some(value => value.target === 'conditional')) {
		expect(selectAssignedRoles(roles, assignments, 'author', now).map(value => value.id)).toEqual(expected);
	}
	const world = setup(selected);
	await world.run('n', 'author', { id: 'n' });
	expect(world.events.filter(event => Array.isArray(event) && event[0] === 'push').map(event => (event as string[])[1])).toEqual(expected.map(roleId => `list:roleTimeline:${roleId}`));
	expect(world.events.filter(event => Array.isArray(event) && event[0] === 'publication')).toHaveLength(expected.length);
});
