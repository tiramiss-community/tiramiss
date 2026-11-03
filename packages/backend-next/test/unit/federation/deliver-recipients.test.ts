/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { collectInboxes } from '../../../src/modules/federation/public.js';
import { loadApDeliverCases } from '../../helpers/ap-deliver-cases.js';
import type { DeliverRecipe, FollowerInbox } from '../../../src/modules/federation/public.js';

interface RecipientCases {
	inputs: {
		actorId: string;
		cases: { id: string; recipes: DeliverRecipe[]; followings: FollowerInbox[]; activity?: null; actorHost?: string }[];
	};
	cases: {
		id: string;
		error?: { name: string; message: string };
		followingsQueries: unknown[];
		deliverMany: { inboxes: [string, boolean][] } | null;
	}[];
}

const recorded = loadApDeliverCases<RecipientCases>('recipient-cases.json');
const expected = new Map(recorded.cases.map(c => [c.id, c]));

// リモートの actor は配送の区画へ入る前に作者の host で除くため、宛先の選定には渡らない（note-delivery の試験で扱う）。
const gatedBefore = new Set(['remote-actor']);

test.for(recorded.inputs.cases.filter(c => !gatedBefore.has(c.id)))('$id selects the same inboxes in the same order as the pinned upstream', async c => {
	const upstream = expected.get(c.id)!;
	let queries = 0;
	const readFollowerInboxes = async () => {
		queries++;
		return c.followings;
	};

	const selecting = collectInboxes(c.recipes, readFollowerInboxes);

	if (upstream.error) {
		// 本家は名前のない Error を投げる。新実装は理由を log に残せる例外にし、メッセージだけを揃える。
		await expect(selecting).rejects.toMatchObject({ message: upstream.error.message, code: 'FOLLOWER_INBOX_MISSING' });
	} else {
		expect([...await selecting]).toEqual(upstream.deliverMany!.inboxes);
	}
	expect(queries).toBe(upstream.followingsQueries.length);
});

test('the only case left to the author gate is the remote actor', () => {
	expect(recorded.cases.filter(c => c.error && c.error.message !== 'inbox is null').map(c => c.id)).toEqual([...gatedBefore]);
});
