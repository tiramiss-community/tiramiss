/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { isPureRenote, renderNoteActivity } from '../../../src/modules/federation/public.js';
import { loadApDeliverCases, renderMaterialsFor, withMentionTagsAsSet } from '../../helpers/ap-deliver-cases.js';
import type { NoteActivityMaterials } from '../../../src/modules/federation/public.js';
import type { RenderCases } from '../../helpers/ap-deliver-cases.js';

const recorded = loadApDeliverCases<RenderCases>('render-cases.json');
const { inputs } = recorded;
const expected = new Map(recorded.cases.map(c => [c.id, c]));
const users = new Map(inputs.users.map(u => [u.id, u]));
const options = { selfUrl: inputs.selfUrl, now: Date.parse(inputs.now) };

function materialsFor(c: RenderCases['inputs']['cases'][number]): NoteActivityMaterials {
	return renderMaterialsFor(inputs, c);
}

// 本家が配送の区画へ入らなかった投稿。表現より前の条件（localOnly・channel・リモートの作者）で止まり、表現の対象ではない。
const notRendered = new Set(['local-only', 'channel', 'remote-author']);

test('every recorded upstream result has an input case', () => {
	expect(recorded.cases.map(c => c.id)).toEqual(inputs.cases.map(c => c.id));
});

test.for(inputs.cases.filter(c => !notRendered.has(c.id)))('$id renders the same activity as the pinned upstream', c => {
	const upstream = expected.get(c.id)!;

	if (upstream.activity === null) {
		// 本家の記録は例外のメッセージだけを持つ。
		expect(() => renderNoteActivity(materialsFor(c), options)).toThrow(expect.objectContaining({ message: upstream.unhandledRejections[0] }));
		return;
	}

	const activity = JSON.stringify(renderNoteActivity(materialsFor(c), options));
	expect(withMentionTagsAsSet(activity)).toBe(withMentionTagsAsSet(upstream.activity));
});

test('the gated cases are exactly the ones upstream never rendered', () => {
	expect(recorded.cases.filter(c => !c.reachedDeliver && c.unhandledRejections.length === 0).map(c => c.id)).toEqual([...notRendered]);
});

test('mention tags follow the saved mentions order instead of the database order', () => {
	const c = inputs.cases.find(x => x.id === 'public-mentions-db-order')!;

	const activity = renderNoteActivity(materialsFor(c), options) as { object: { tag: { type: string; href: string }[] } };

	const hrefs = c.note.mentions.map(id => {
		const user = users.get(id)!;
		return user.host === null ? `${inputs.selfUrl}/users/${user.id}` : user.uri;
	});
	expect(activity.object.tag.filter(tag => tag.type === 'Mention').map(tag => tag.href)).toEqual(hrefs);
});

test('a pure renote whose remote target vanished before rendering is not announced', () => {
	const c = inputs.cases.find(x => x.id === 'renote-public-remote')!;
	const materials = { ...materialsFor(c), renote: null };

	expect(() => renderNoteActivity(materials, options)).toThrow('renderAnnounce: renote target is gone');
});

type RenoteColumns = Parameters<typeof isPureRenote>[0];

test.for<[string, Partial<RenoteColumns>]>([
	['text', { text: 'x' }],
	['cw', { cw: '' }],
	['reply', { replyId: 'reply' }],
	['poll', { hasPoll: true }],
	['files', { fileIds: ['file'] }],
])('a renote with %s is a quote, not a pure renote', ([, change]) => {
	const base: RenoteColumns = { renoteId: 'renote', text: null, replyId: null, cw: null, hasPoll: false, fileIds: [] };

	expect(isPureRenote(base)).toBe(true);
	expect(isPureRenote({ ...base, ...change })).toBe(false);
	expect(isPureRenote({ ...base, renoteId: null })).toBe(false);
});

test('publication can reuse prepared rendering without adding nested context while delivery keeps context', () => {
	const c = inputs.cases.find(x => x.id === 'public-mentions-db-order')!;
	const materials = materialsFor(c);
	const bare = renderNoteActivity(materials, options, false);
	expect(bare).not.toHaveProperty('@context');
	expect(bare.object).not.toHaveProperty('@context');
	expect(renderNoteActivity(materials, options)).toEqual({ '@context': expect.any(Array), ...bare });
});
