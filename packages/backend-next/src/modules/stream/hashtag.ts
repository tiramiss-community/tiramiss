/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { object } from './channel.js';
import { hideStreamNote, noteMuted, noteVisible, pureRenote } from './policy.js';
import type { StreamChannelDefinition, StreamPorts } from './channel.js';
import type { StreamNote } from './policy.js';

export function createHashtagChannel(ports: StreamPorts): StreamChannelDefinition {
	return {
		requireCredential: false, kind: null, shouldShare: false,
		create({ params, send }) {
			const query = params.q;
			if (!Array.isArray(query) || !query.every((terms): terms is string[] => Array.isArray(terms) && terms.length >= 1 && terms.every(term => typeof term === 'string'))) {
				return null;
			}
			const normalized = query.map(terms => terms.map(term => term.normalize('NFKC').toLowerCase()));
			return {
				async publish({ channel, message, facts, hidingFollowing }) {
					if (channel !== 'notesStream' || !object(message)) {
						return;
					}
					const note = message as StreamNote;
					const tags = Array.isArray(note.tags) ? note.tags.map((tag: string) => tag.toLowerCase()) : [];
					if (!normalized.some(terms => terms.every(term => tags.includes(term))) || !noteVisible(note, facts) || noteMuted(note, facts)) {
						return;
					}
					if (facts.userId === null && [note, note.renote, note.reply].some(related => related?.user.requireSigninToViewContents)) {
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
						if (chain.some(related => related.visibility === 'followers' && related.userId !== facts.userId)) {
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
