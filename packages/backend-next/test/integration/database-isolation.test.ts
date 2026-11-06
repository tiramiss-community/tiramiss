/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';

test('separate test databases cannot read one another’s cached empty-host instance', async () => {
	const first = await createTestDatabase();
	let second: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
	const clients: Redis[] = [];
	// A unique logical key reproduces the collision without replacing another test's cache.
	const key = `database-isolation:${randomUUID()}:kvcache:federatedInstance:`;
	const cached = JSON.stringify({
		id: randomUUID(),
		host: '',
		isNotResponding: true,
		notRespondingSince: '2026-11-06T01:02:03.000Z',
		suspensionState: 'none',
		softwareName: null,
		softwareVersion: null,
	});

	try {
		second = await createTestDatabase();
		const writer = new Redis(first.config.redis);
		const reader = new Redis(second.config.redis);
		clients.push(writer, reader);

		await writer.set(key, cached, 'EX', 60);
		expect(await writer.get(key)).toBe(cached);
		expect(await reader.get(key)).toBeNull();
		expect(second.config.database.database).not.toBe(first.config.database.database);

		for (const { config } of [first, second]) {
			for (const redis of [config.redisForPubsub, config.redisForJobQueue]) {
				expect(redis.prefix).toBe(config.redis.prefix);
				expect(redis.keyPrefix).toBe(config.redis.keyPrefix);
			}
		}
	} finally {
		try {
			await clients[0]?.del(key);
		} finally {
			for (const client of clients) {
				client.disconnect();
			}
			await Promise.all([first.close(), second?.close()]);
		}
	}
});
