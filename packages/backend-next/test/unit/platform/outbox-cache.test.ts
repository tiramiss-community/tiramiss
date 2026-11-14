/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createOutboxReader } from '../../../src/platform/database/local-outbox.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
test.each([null, [[null, ['a']], [null, ['b']]]])('pipeline result %j preserves full list contract and null-as-empty', async result => {
	const pipeline = { lrange: vi.fn(), exec: vi.fn(async () => result) };
	const reader = createOutboxReader({} as EntityManager, { pipeline: () => pipeline } as unknown as Redis);
	expect(await reader.readTimelineIds('alice')).toEqual(result === null ? [] : [['a'], ['b']]);
	expect(pipeline.lrange.mock.calls).toEqual([['list:userTimeline:alice', 0, -1], ['list:userTimelineWithReplies:alice', 0, -1]]);
});
test('Redis command error rejects rather than returning empty candidates', async () => {
	const pipeline = { lrange: vi.fn(), exec: vi.fn(async () => [[new Error('WRONGTYPE'), null]]) };
	const reader = createOutboxReader({} as EntityManager, { pipeline: () => pipeline } as unknown as Redis);
	await expect(reader.readTimelineIds('alice')).rejects.toThrow('WRONGTYPE');
});
