/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { filterHomeNote, hideStreamNote, instanceMuted, noteMuted, noteVisible, pureRenote } from './policy.js';
import type { StreamFacts, StreamNote } from './policy.js';
import type { QueueStatsReader } from '../queue/public.js';

export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createStreamConnection(ports: {
	facts(): StreamFacts;
	hidingFollowing?(): Promise<ReadonlySet<string>>;
	now(): number;
	send(value: { type: string; body: unknown }): void;
	repack(id: string): Promise<Record<string, unknown> | null>;
	reaction(note: StreamNote): Promise<string | undefined>;
	queueStats?: QueueStatsReader;
}) {
	const channels = new Map<string, { name: string; params: Record<string, unknown>; dispose?: () => void }>();
	const notes = new Map<string, number>();
	let disposed = false;
	const disconnect = (id: string) => {
		channels.get(id)?.dispose?.();
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
				if (channels.get(id)?.name === 'queueStats' && body.type === 'requestLog' && object(body.body) && typeof body.body.id === 'string' && typeof body.body.length === 'number') {
					ports.send({ type: 'channel', body: { id, type: 'statsLog', body: ports.queueStats!.readLog(body.body.length) } });
				}
			} else if (type === 'connect') {
				if (typeof body.channel !== 'string' || (body.params !== undefined && !object(body.params)) || (body.pong != null && typeof body.pong !== 'boolean')) {
					return;
				}
				disconnect(id);
				const publicStats = body.channel === 'queueStats' && ports.queueStats !== undefined;
				if (channels.size >= 32 || (!publicStats && (ports.facts().userId === null || !['main', 'homeTimeline'].includes(body.channel)))) {
					return;
				}
				if ((body.channel === 'main' || body.channel === 'queueStats') && [...channels.values()].some(c => c.name === body.channel)) {
					return;
				}
				channels.set(id, { name: body.channel, params: body.params as Record<string, unknown> ?? {} });
				if (publicStats) {
					channels.get(id)!.dispose = ports.queueStats!.subscribe(sample => {
						if (!disposed && channels.get(id)?.name === 'queueStats') {
							ports.send({ type: 'channel', body: { id, type: 'stats', body: sample } });
						}
					});
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
			for (const [id, connection] of channels) {
				try {
					if (connection.name === 'homeTimeline' && channel === 'notesStream' && object(message)) {
						const note = message as StreamNote;
						if (!filterHomeNote(note, facts, connection.params)) {
							continue;
						}
						let hidingFacts = facts;
						if (ports.hidingFollowing) {
							const chain: StreamNote[] = [];
							for (let current: StreamNote | null | undefined = note; current; current = current.renote) {
								chain.push(current);
								if (current.reply) {
									chain.push(current.reply);
								}
							}
							if (chain.some(n => n.visibility === 'followers' && n.userId !== facts.userId)) {
								hidingFollowing ??= ports.hidingFollowing();
								const following = await hidingFollowing;
								hidingFacts = { ...facts, following: new Map([...following].map(userId => [userId, { withReplies: false }])) };
							}
						}
						const filtered = hideStreamNote(note, hidingFacts, ports.now());
						if (!filtered) {
							continue;
						}
						if (pureRenote(filtered) && filtered.renote && Object.keys(filtered.renote.reactions ?? {}).length > 0) {
							filtered.renote.myReaction = await ports.reaction(filtered.renote);
						}
						ports.send({ type: 'channel', body: { id, type: 'note', body: filtered } });
					} else if (connection.name === 'main' && channel === `mainStream:${facts.userId}` && object(message) && typeof message.type === 'string') {
						let body = structuredClone(message.body);
						if (message.type === 'notification' && object(body)) {
							const actor = object(body.user) ? body.user : {};
							if (facts.mutedInstances.has(String(actor.host ?? '')) || (typeof body.userId === 'string' && facts.mutedUsers.has(body.userId))) {
								continue;
							}
							if (object(body.note) && body.note.isHidden) {
								body.note = await ports.repack(String(body.note.id));
							}
						} else if (message.type === 'mention' && object(body)) {
							const note = body as StreamNote;
							if (instanceMuted(note, facts) || !noteVisible(note, facts) || noteMuted(note, facts)) {
								continue;
							}
							if (note.isHidden) {
								body = await ports.repack(note.id);
							}
						}
						ports.send({ type: 'channel', body: { id, type: message.type, body } });
					}
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
