/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { webfingerCorpus as corpus } from '../../helpers/webfinger-source.js';
import { localWebfingerQuery, renderLocalWebfinger, renderWebfingerXrd } from '../../../src/modules/federation/public.js';

test.each(corpus.cases.filter(c => c.resource !== null && (c.expected.query !== null || c.expected.status === 422)))('$id preserves the pinned resource lookup, including permissive account parsing', c => {
	expect(localWebfingerQuery(c.resource!, corpus.defaults.selfUrl)).toEqual(c.expected.query);
});

test('stored username casing and non-default port reach exactly the three discovery links', () => {
	expect(renderLocalWebfinger({ id: 'id', username: 'Alice' }, corpus.defaults.selfUrl)).toEqual(corpus.defaults.jrd);
});

test.each(corpus.cases.filter(c => c.expected.format === 'xrd' && c.method !== 'HEAD'))('$id preserves the literal pinned XRD output, including escaping quirks', c => {
	const facts = { ...corpus.defaults.row, ...c.row };
	expect(renderWebfingerXrd(renderLocalWebfinger(facts, corpus.defaults.selfUrl))).toBe(c.expected.body ?? corpus.defaults.xrd);
});
