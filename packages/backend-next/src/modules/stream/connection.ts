/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { object } from './channel.js';
import { createStreamChannelRegistry } from './registry.js';
import type { StreamChannel, StreamChannelDefinition, StreamPorts } from './channel.js';

export { object } from './channel.js';

export function createStreamConnection(ports: StreamPorts, registry: ReadonlyMap<string, StreamChannelDefinition> = createStreamChannelRegistry(ports)) {
	const channels = new Map<string, { name: string; instance: StreamChannel }>();
	const notes = new Map<string, number>();
	let disposed = false;
	const disconnect = (id: string) => {
		channels.get(id)?.instance.dispose?.();
		channels.delete(id);
	};
	return {
		dispose(): void {
			disposed = true;
			for (const id of channels.keys()) {
				disconnect(id);
			}
			notes.clear();
		},
		async receive(value: unknown): Promise<void> {
			if (disposed || !object(value) || !object(value.body)) {
				return;
			}
			const { type, body } = value;
			if (typeof body.id !== 'string') {
				return;
			}
			const id = body.id;
			if (type === 'subNote' || type === 's' || type === 'sr') {
				if (!id) {
					return;
				}
				const count = notes.get(id) ?? 0;
				if (count === 0 && notes.size >= 1536) {
					notes.delete(notes.keys().next().value!);
				}
				notes.delete(id);
				notes.set(id, count + 1);
			} else if (type === 'unsubNote' || type === 'un') {
				const count = notes.get(id);
				if (count != null && count > 1) {
					notes.set(id, count - 1);
				} else {
					notes.delete(id);
				}
			} else if (type === 'disconnect') {
				disconnect(id);
			} else if (type === 'channel' || type === 'ch') {
				if (typeof body.type === 'string' && body.body !== undefined) {
					channels.get(id)?.instance.onMessage?.(body.type, body.body);
				}
			} else if (type === 'connect') {
				if (typeof body.channel !== 'string' || (body.params !== undefined && !object(body.params)) || (body.pong != null && typeof body.pong !== 'boolean')) {
					return;
				}
				disconnect(id);
				const definition = registry.get(body.channel);
				if (channels.size >= 32 || !definition || (definition.requireCredential && ports.facts().userId === null)) {
					return;
				}
				if (ports.tokenPermissions && ((definition.kind && !ports.tokenPermissions.includes(definition.kind)) || (!definition.kind && definition.requireCredential))) {
					return;
				}
				if (definition.shouldShare && [...channels.values()].some(c => c.name === body.channel)) {
					return;
				}
				const connection = { name: body.channel, instance: {} as StreamChannel };
				channels.set(id, connection);
				try {
					const instance = definition.create({ params: body.params as Record<string, unknown> ?? {}, send: (type, payload) => {
						if (!disposed && channels.get(id) === connection) {
							ports.send({ type: 'channel', body: { id, type, body: payload } });
						}
					} });
					if (instance === null) {
						channels.delete(id);
						return;
					}
					connection.instance = instance;
				} catch (error) {
					channels.delete(id);
					throw error;
				}
				if (body.pong) {
					ports.send({ type: 'connected', body: { id } });
				}
			}
		},
		async publish(value: unknown): Promise<void> {
			if (disposed || !object(value) || typeof value.channel !== 'string') {
				return;
			}
			const facts = ports.facts();
			const { channel, message } = value;
			if (channel.startsWith('noteStream:') && notes.has(channel.slice(11)) && object(message) && object(message.body)) {
				const body = message.body;
				if (body.userId !== facts.userId && ((body.visibility === 'specified' && (facts.userId === null || !Array.isArray(body.visibleUserIds) || !body.visibleUserIds.includes(facts.userId))) || (body.visibility === 'followers' && !facts.following.has(String(body.userId))))) {
					return;
				}
				if (facts.userId === null && facts.ugcVisibilityForVisitor === 'none') {
					return;
				}
				ports.send({ type: 'noteUpdated', body: { id: body.id, type: message.type, body: body.body } });
				return;
			}
			const errors: unknown[] = [];
			let hidingFollowing: Promise<ReadonlySet<string>> | undefined;
			const readFollowing = ports.hidingFollowing;
			for (const connection of channels.values()) {
				try {
					await connection.instance.publish?.({ channel, message, facts, hidingFollowing: readFollowing ? () => hidingFollowing ??= readFollowing() : undefined });
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) {
				throw new AggregateError(errors, 'STREAM_CHANNEL_DELIVERY_FAILED');
			}
		},
	};
}
