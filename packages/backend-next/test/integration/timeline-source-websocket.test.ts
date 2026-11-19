/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { emptyStreamFacts } from '../../src/modules/stream/public.js';
import { openStreamingServer } from '../../src/platform/streaming-server.js';
import { createPostingStream } from '../../src/platform/posting-stream.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { testConfig } from '../helpers/database.js';

const completion = vi.hoisted(() => ({ sequence: 0 }));

// Observe completion while forwarding the actual receiver, filters and channel lifecycle.
vi.mock('../../src/modules/stream/public.js', async importOriginal => {
	const original = await importOriginal<typeof import('../../src/modules/stream/public.js')>();
	return { ...original, createStreamConnection(...args: Parameters<typeof original.createStreamConnection>) {
		const connection = original.createStreamConnection(...args);
		return { ...connection, async publish(value: unknown) {
			await connection.publish(value);
			completion.sequence++;
		} };
	} };
});

const corpus = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/stream/timelines/source-cases.json', import.meta.url), 'utf8'));

test('all pinned timeline observations match real Redis producer and WebSocket delivery', async () => {
	const config = testConfig();
	const server = await listenHttp(new Hono(), config.http);
	const redis = new Redis(config.redis);
	const url = 'http://timeline456-source.test';
	let current = corpus.observations[0];
	const errors: unknown[] = [];
	const streaming = await openStreamingServer(server, {
		redis: config.redis, selfUrl: url, logger: { info() {}, error: (...args: unknown[]) => errors.push(args) }, onFailure: error => errors.push(error),
		ports: {
			authenticate: async () => current.input.facts.user ? { userId: current.input.facts.user.id, canReadAccount: true, isSuspended: false } : null,
			timelinePolicies: async () => current.input.facts.policies,
			readFacts: async () => {
				const original = current.input.facts;
				return { ...emptyStreamFacts(original.user?.id ?? null), following: new Map<string, { withReplies: boolean }>(Object.entries(original.following)), followingChannels: new Set<string>(original.followingChannels), mutedChannels: new Set<string>(original.mutingChannels), mutedUsers: new Set<string>(original.muting), blockingUsers: new Set<string>(original.blockingMe), renoteMutedUsers: new Set<string>(original.renoteMuting), mutedInstances: new Set<string>(original.mutedInstances), ugcVisibilityForVisitor: original.ugc };
			},
			hidingFollowing: async () => new Set<string>(Object.keys(current.input.facts.hidingFollowing ?? current.input.facts.following)),
			repack: async () => {
				throw new Error('TIMELINE_MUST_USE_SNAPSHOT');
			}, reaction: async () => ':own:', touchActivity: async () => {},
		},
	});
	const publisher = createPostingStream(redis, url);
	const sockets: WebSocket[] = [];
	try {
		for (const record of corpus.observations) {
			current = record;
			const messages: any[] = [];
			const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/streaming`);
			sockets.push(socket);
			socket.on('message', data => messages.push(JSON.parse(data.toString())));
			await new Promise<void>((resolve, reject) => {
				socket.once('open', resolve); socket.once('error', reject);
			});
			socket.send(JSON.stringify({ type: 'connect', body: { id: 'channel-id', channel: record.input.channel, params: record.input.params, pong: true } }));
			await vi.waitFor(() => expect(messages).toContainEqual({ type: 'connected', body: { id: 'channel-id' } }), { interval: 1 });
			const before = completion.sequence;
			await publisher.notes(record.input.payload);
			await vi.waitFor(() => expect(completion.sequence).toBe(before + 1), { interval: 1 });
			// The pong follows all earlier server writes on this socket, including a wrongly sent note.
			await new Promise<void>(resolve => {
				socket.once('pong', () => resolve()); socket.ping();
			});
			const notes = messages.filter(message => message.type === 'channel');
			expect(notes, record.id).toEqual(record.sent);
			await new Promise<void>(resolve => {
				socket.once('close', () => resolve()); socket.close();
			});
		}
		expect(errors).toEqual([]);
	} finally {
		for (const socket of sockets) {
			socket.terminate();
		}
		await streaming.close();
		await closeHttp(server);
		redis.disconnect();
	}
});
