/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { getNoteHtml } from '../../../src/modules/mfm/public.js';
import { loadApDeliverCases } from '../../helpers/ap-deliver-cases.js';
import type { MentionedRemoteUser } from '../../../src/modules/mfm/public.js';

type MfmHtmlCases = {
	inputs: {
		selfUrl: string;
		mentionedRemoteUsers: MentionedRemoteUser[];
		cases: { id: string; text: string | null; mentionedRemoteUsers?: MentionedRemoteUser[]; extraHtml?: string | null }[];
	};
	cases: ({ id: string; content: string; noMisskeyContent: boolean } | { id: string; error: { name: string; message: string } })[];
};

const recorded = loadApDeliverCases<MfmHtmlCases>('mfm-html-cases.json');
const expected = new Map(recorded.cases.map(c => [c.id, c]));

test('every recorded upstream result has an input case', () => {
	expect(recorded.cases.map(c => c.id)).toEqual(recorded.inputs.cases.map(c => c.id));
});

test.for(recorded.inputs.cases)('$id renders the same HTML as the pinned upstream', c => {
	const upstream = expected.get(c.id)!;
	const note = { text: c.text, mentionedRemoteUsers: c.mentionedRemoteUsers ?? recorded.inputs.mentionedRemoteUsers };

	if ('error' in upstream) {
		let thrown: unknown;
		try {
			getNoteHtml(note, recorded.inputs.selfUrl, c.extraHtml ?? null);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect({ name: (thrown as Error).name, message: (thrown as Error).message }).toEqual(upstream.error);
		return;
	}

	expect(getNoteHtml(note, recorded.inputs.selfUrl, c.extraHtml ?? null)).toEqual({ content: upstream.content, noMisskeyContent: upstream.noMisskeyContent });
});
