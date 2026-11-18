/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createStreamConnection, createStreamChannelRegistry, emptyStreamFacts, type StreamPorts } from '../../../src/modules/stream/public.js';

function connect(tokenPermissions?: readonly string[]) {
	const sent: unknown[] = [];
	const stream = createStreamConnection({ facts: () => emptyStreamFacts('me'), now: () => 0, send: value => sent.push(value), repack: async () => null, reaction: async () => undefined, tokenPermissions });
	return { stream, sent };
}

test('channel permission denies an app even when the receiver has an authenticated user', async () => {
	const { stream, sent } = connect([]);
	await stream.receive({ type: 'connect', body: { id: 'm', channel: 'main', pong: true } });
	await stream.publish({ channel: 'mainStream:me', message: { type: 'reply', body: {} } });
	expect(sent).toEqual([]);
});

test('native and read account tokens can subscribe to main', async () => {
	for (const permissions of [undefined, ['read:account']]) {
		const { stream, sent } = connect(permissions);
		await stream.receive({ type: 'connect', body: { id: 'm', channel: 'main', pong: true } });
		expect(sent).toEqual([{ type: 'connected', body: { id: 'm' } }]);
	}
});

test('registered implementation receives params and events, while old callbacks stop on ID replacement', async () => {
	const sent: unknown[] = [];
	const callbacks: ((type: string, body: unknown) => void)[] = [];
	let disposed = 0;
	const registry = new Map([['example', {
		requireCredential: false, kind: null, shouldShare: false,
		create({ params, send }: { params: Record<string, unknown>; send(type: string, body: unknown): void }) {
			callbacks.push(send);
			return {
				async publish() {
					send('event', params);
				},
				onMessage: send,
				dispose() {
					disposed++;
				},
			};
		},
	}]]);
	const stream = createStreamConnection({ facts: () => emptyStreamFacts(null), now: () => 0, send: value => sent.push(value), repack: async () => null, reaction: async () => undefined }, registry);
	await stream.receive({ type: 'connect', body: { id: 'x', channel: 'example', params: { value: 1 }, pong: true } });
	await stream.publish({ channel: 'custom', message: {} });
	await stream.receive({ type: 'ch', body: { id: 'x', type: 'echo', body: { value: 2 } } });
	await stream.receive({ type: 'connect', body: { id: 'x', channel: 'unknown', pong: true } });
	callbacks[0]('stale', {});
	expect(disposed).toBe(1);
	expect(sent).toEqual([
		{ type: 'connected', body: { id: 'x' } },
		{ type: 'channel', body: { id: 'x', type: 'event', body: { value: 1 } } },
		{ type: 'channel', body: { id: 'x', type: 'echo', body: { value: 2 } } },
	]);
	await stream.receive({ type: 'connect', body: { id: 'x', channel: 'example' } });
	stream.dispose();
	stream.dispose();
	callbacks[1]('stale', {});
	expect(disposed).toBe(2);
	expect(sent).toHaveLength(3);
});

const corpus = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/stream/registry-cases.json', import.meta.url), 'utf8')) as {
	observations: { id: string; input: { user: { id: string } | null; token: { permission: string[] } | null; operations: [string, string][] }; sent: unknown[]; disposed: string[]; errors: string[] }[];
};

for (const record of corpus.observations) {
	test(`fixed upstream lifecycle: ${record.id}`, async () => {
		const sent: unknown[] = [];
		const disposed: string[] = [];
		const ports: StreamPorts = {
			facts: () => emptyStreamFacts(record.input.user?.id ?? null), now: () => 0,
			tokenPermissions: record.input.token?.permission,
			send: value => sent.push(value), repack: async () => null, reaction: async () => undefined,
			queueStats: { subscribe: () => () => {}, readLog: () => [] },
		};
		const registry = new Map([...createStreamChannelRegistry(ports)].map(([name, definition]) => [name, {
			...definition,
			create(context: Parameters<typeof definition.create>[0]) {
				const channel = definition.create(context);
				return { ...channel, dispose() {
					channel?.dispose?.();
					disposed.push(name);
				} };
			},
		}]));
		const stream = createStreamConnection(ports, registry);
		for (const [id, channel] of record.input.operations) {
			await stream.receive({ type: 'connect', body: { id, channel, pong: true } });
		}
		stream.dispose();
		expect(sent).toEqual(record.sent);
		expect(disposed).toEqual(record.disposed);
		// Unknown channels preserve the existing receiver's deliberate ignore behavior.
		expect(record.errors).toEqual(record.id === 'registry-replace-unknown' ? ['no such channel: unknown'] : []);
	});
}

test('disconnect suppresses a hidden main delivery that completes after channel disposal', async () => {
	const sent: unknown[] = [];
	let complete!: (value: Record<string, unknown>) => void;
	let rendering!: () => void;
	const started = new Promise<void>(resolve => {
		rendering = resolve;
	});
	const stream = createStreamConnection({ facts: () => emptyStreamFacts('me'), now: () => 0, send: value => sent.push(value), reaction: async () => undefined, repack: () => {
		rendering();
		return new Promise(resolve => {
			complete = resolve;
		});
	} });
	await stream.receive({ type: 'connect', body: { id: 'm', channel: 'main' } });
	const publishing = stream.publish({ channel: 'mainStream:me', message: { type: 'notification', body: { note: { id: 'n', isHidden: true } } } });
	await started;
	await stream.receive({ type: 'disconnect', body: { id: 'm' } });
	complete({ id: 'n', text: 'late' });
	await publishing;
	expect(sent).toEqual([]);
});
