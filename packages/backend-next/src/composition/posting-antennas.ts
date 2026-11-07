/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { checkHitAntenna } from '../modules/note/public.js';
import type { AntennaDefinition, AntennaMatchPorts, NotePostSaveInput } from '../modules/note/public.js';
import type { createTimelineCache } from '../platform/timeline-cache.js';
export function createPostingAntennas(ports: AntennaMatchPorts & {
	definitions(): Promise<AntennaDefinition[]>;
	cache: ReturnType<typeof createTimelineCache>;
	publish(id: string, note: Record<string, unknown>): Promise<void>;
}) {
	return async (input: NotePostSaveInput): Promise<void> => {
		const snapshot = input.createdSnapshot;
		if (!snapshot?.author || !snapshot.rawNote || snapshot.channel === undefined) {
			throw new Error('Antenna creation snapshot missing');
		}
		const author = snapshot.author;
		const note = { ...snapshot.note, channel: snapshot.channel };
		const definitions = await ports.definitions();
		const matches = await Promise.allSettled(definitions.map(antenna => checkHitAntenna(antenna, note, author, ports)));
		const failures = matches.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Antenna matching failed');
		}
		const batch = ports.cache.begin(note.id);
		const work: Promise<unknown>[] = [];
		const rawNote = { ...snapshot.rawNote, channel: snapshot.channel?.raw ?? snapshot.channel };
		try {
			for (let index = 0; index < definitions.length; index++) {
				const match = matches[index];
				if (match.status !== 'fulfilled' || !match.value) {
					continue;
				}
				const antenna = definitions[index];
				batch.push({ name: `antennaTimeline:${antenna.id}`, maxlen: 200 });
				const publication = ports.publish(antenna.id, rawNote);
				// 送信の拒否を直ちに処理し、残りの宛先と pipeline を開始してから全体を待つ。
				void publication.catch(() => { });
				work.push(publication);
			}
			work.push(batch.flush());
		} catch (error) {
			failures.push(error);
			work.push(batch.drain());
		}
		const results = await Promise.allSettled(work);
		failures.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Antenna output failed');
		}
	};
}
