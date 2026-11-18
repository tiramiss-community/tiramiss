/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { object } from './channel.js';
import { createHashtagChannel } from './hashtag.js';
import { filterHomeNote, hideStreamNote, instanceMuted, noteMuted, noteVisible, pureRenote } from './policy.js';
import type { StreamChannelDefinition, StreamPorts } from './channel.js';
import type { StreamNote } from './policy.js';

export function createStreamChannelRegistry(ports: StreamPorts): ReadonlyMap<string, StreamChannelDefinition> {
	const registry = new Map<string, StreamChannelDefinition>([
		['hashtag', createHashtagChannel(ports)],
		['main', {
			requireCredential: true, kind: 'read:account', shouldShare: true,
			create: ({ send }) => ({
				async publish({ channel, message, facts }) {
					if (channel !== `mainStream:${facts.userId}` || !object(message) || typeof message.type !== 'string') {
						return;
					}
					let body = structuredClone(message.body);
					if (message.type === 'notification' && object(body)) {
						const actor = object(body.user) ? body.user : {};
						if (facts.mutedInstances.has(String(actor.host ?? '')) || (typeof body.userId === 'string' && facts.mutedUsers.has(body.userId))) {
							return;
						}
						if (object(body.note) && body.note.isHidden) {
							body.note = await ports.repack(String(body.note.id));
						}
					} else if (message.type === 'mention' && object(body)) {
						const note = body as StreamNote;
						if (instanceMuted(note, facts) || !noteVisible(note, facts) || noteMuted(note, facts)) {
							return;
						}
						if (note.isHidden) {
							body = await ports.repack(note.id);
						}
					}
					send(message.type, body);
				},
			}),
		}],
		['homeTimeline', {
			requireCredential: true, kind: 'read:account', shouldShare: false,
			create: ({ params, send }) => ({
				async publish(publication) {
					const { channel, message, facts } = publication;
					if (channel !== 'notesStream' || !object(message)) {
						return;
					}
					const note = message as StreamNote;
					if (!filterHomeNote(note, facts, params)) {
						return;
					}
					let hidingFacts = facts;
					if (publication.hidingFollowing) {
						const chain: StreamNote[] = [];
						for (let current: StreamNote | null | undefined = note; current; current = current.renote) {
							chain.push(current);
							if (current.reply) {
								chain.push(current.reply);
							}
						}
						if (chain.some(n => n.visibility === 'followers' && n.userId !== facts.userId)) {
							const following = await publication.hidingFollowing();
							hidingFacts = { ...facts, following: new Map([...following].map(userId => [userId, { withReplies: false }])) };
						}
					}
					const filtered = hideStreamNote(note, hidingFacts, ports.now());
					if (!filtered) {
						return;
					}
					if (pureRenote(filtered) && filtered.renote && Object.keys(filtered.renote.reactions ?? {}).length > 0) {
						filtered.renote.myReaction = await ports.reaction(filtered.renote);
					}
					send('note', filtered);
				},
			}),
		}],
	]);
	const stats = ports.queueStats;
	if (stats) {
		registry.set('queueStats', {
			requireCredential: false, kind: null, shouldShare: true,
			create: ({ send }) => {
				const dispose = stats.subscribe(sample => send('stats', sample));
				return {
					onMessage(type, body) {
						if (type === 'requestLog' && object(body) && typeof body.id === 'string' && typeof body.length === 'number') {
							send('statsLog', stats.readLog(body.length));
						}
					},
					dispose,
				};
			},
		});
	}
	return registry;
}
