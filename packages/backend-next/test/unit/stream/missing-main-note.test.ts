/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createStreamingReader } from '../../../src/platform/database/streaming.js';
import { createStreamConnection, emptyStreamFacts } from '../../../src/modules/stream/public.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';

// The repository represents a root deleted between publication and this receiver's read.
const manager = { getRepository: () => ({ findBy: async () => [] }) } as unknown as EntityManager;
const logger = { info() {}, error() {} };

test.each(['notification', 'mention'])('a missing hidden %s root emits no nullable payload and does not block later events', async type => {
	const reader = createStreamingReader(manager, {} as Redis, logger, { url: 'http://example.test', createdAtFromId: () => 0 });
	const sent: unknown[] = [];
	const connection = createStreamConnection({
		facts: () => emptyStreamFacts('viewer'), now: Date.now, send: value => sent.push(value),
		repack: id => reader.repack(id, 'viewer'), reaction: async () => undefined,
	});
	await connection.receive({ type: 'connect', body: { id: 'main', channel: 'main' } });
	const note = { id: 'deleted', userId: 'author', user: { id: 'author', host: null }, visibility: 'public', text: null, isHidden: true };
	const body = type === 'notification' ? { id: 'notification', type: 'mention', userId: 'author', note } : note;
	await expect(connection.publish({ channel: 'mainStream:viewer', message: { type, body } })).rejects.toThrow('STREAM_CHANNEL_DELIVERY_FAILED');
	expect(sent).toEqual([]);
	const visible = { ...note, id: 'later', text: 'later published snapshot', isHidden: false };
	const nextBody = type === 'notification' ? { ...body, note: visible } : visible;
	await connection.publish({ channel: 'mainStream:viewer', message: { type, body: nextBody } });
	expect(sent).toEqual([{ type: 'channel', body: { id: 'main', type, body: nextBody } }]);
});
