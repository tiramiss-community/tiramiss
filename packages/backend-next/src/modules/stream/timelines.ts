/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { object } from './channel.js';
import { hideStreamNote, noteMuted, noteVisible, pureRenote } from './policy.js';
import type { StreamChannelDefinition, StreamPorts } from './channel.js';
import type { StreamFacts, StreamNote } from './policy.js';

type Timeline = 'localTimeline' | 'hybridTimeline' | 'globalTimeline';

function matches(name: Timeline, note: StreamNote, facts: StreamFacts, params: Record<string, unknown>): boolean {
	if (params.withFiles && !note.fileIds?.length) {
		return false;
	}
	if (name === 'hybridTimeline') {
		const me = note.userId === facts.userId;
		if (note.channelId ? !facts.followingChannels.has(note.channelId) : !me && !facts.following.has(note.userId) && !(note.user.host == null && note.visibility === 'public')) {
			return false;
		}
		if (!noteVisible(note, facts)) {
			return false;
		}
		const privateReply = (reply: StreamNote) => reply.visibility === 'followers' && !facts.following.has(reply.userId) && reply.userId !== facts.userId;
		if (note.reply) {
			if (facts.following.get(note.userId)?.withReplies || params.withReplies) {
				if (privateReply(note.reply)) {
					return false;
				}
			} else if (note.reply.userId !== facts.userId && !me && note.reply.userId !== note.userId) {
				return false;
			}
		}
		if (pureRenote(note) && note.renote && (!(params.withRenotes ?? true) || (note.renote.reply && privateReply(note.renote.reply)))) {
			return false;
		}
	} else {
		if (name === 'localTimeline' && note.user.host !== null) {
			return false;
		}
		if (note.visibility !== 'public' || note.channelId != null) {
			return false;
		}
		if (facts.userId === null && [note, note.renote, note.reply].some(n => n?.user.requireSigninToViewContents)) {
			return false;
		}
		if (name === 'localTimeline' && note.reply && facts.userId !== null && !facts.following.get(note.userId)?.withReplies && !params.withReplies && note.reply.userId !== facts.userId && note.userId !== facts.userId && note.reply.userId !== note.userId) {
			return false;
		}
		if (pureRenote(note) && !(params.withRenotes ?? true)) {
			return false;
		}
	}
	return !noteMuted(note, facts);
}

export function createTimelineChannel(name: Timeline, ports: StreamPorts): StreamChannelDefinition {
	return {
		requireCredential: name === 'hybridTimeline', kind: name === 'hybridTimeline' ? 'read:account' : null, shouldShare: false,
		async create({ params, send }) {
			const policies = await ports.timelinePolicies?.();
			// Upstream acknowledges denied channels, but attaches no notes listener.
			if (!policies || !(name === 'globalTimeline' ? policies.gtlAvailable : policies.ltlAvailable)) {
				return {};
			}
			return {
				async publish({ channel, message, facts, hidingFollowing }) {
					if (channel !== 'notesStream' || !object(message)) {
						return;
					}
					const note = message as StreamNote;
					if (!matches(name, note, facts, params)) {
						return;
					}
					let hidingFacts = facts;
					if (hidingFollowing) {
						const chain: StreamNote[] = [];
						for (let current: StreamNote | null | undefined = note; current; current = current.renote) {
							chain.push(current);
							if (current.reply) {
								chain.push(current.reply);
							}
						}
						if (chain.some(n => n.visibility === 'followers' && n.userId !== facts.userId)) {
							const following = await hidingFollowing();
							hidingFacts = { ...facts, following: new Map([...following].map(userId => [userId, { withReplies: false }])) };
						}
					}
					const filtered = hideStreamNote(note, hidingFacts, ports.now());
					if (!filtered) {
						return;
					}
					if (facts.userId !== null && pureRenote(filtered) && filtered.renote && Object.keys(filtered.renote.reactions ?? {}).length > 0) {
						filtered.renote.myReaction = await ports.reaction(filtered.renote);
					}
					send('note', filtered);
				},
			};
		},
	};
}
