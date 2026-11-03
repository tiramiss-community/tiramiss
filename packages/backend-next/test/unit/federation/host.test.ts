/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createHostRules, punyHost, toPuny, toPunyNullable } from '../../../src/modules/federation/public.js';

type HostCase =
	| { fn: 'toPuny'; host: string; expected: string }
	| { fn: 'toPunyNullable'; host: string | null; expected: string | null }
	| { fn: 'punyHost'; url: string; expected: string }
	| { fn: 'isSelfHost'; selfHost: string; host: string | null; expected: boolean }
	| { fn: 'fullApAccount'; selfHost: string; host: string | null; expected: string }
	| { fn: 'isUriLocal'; selfHost: string; url: string; expected: boolean }
	| { fn: 'emojiHost'; selfHost: string; name: string; noteUserHost: string | null; expected: string | null };

const { cases } = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/federation-base/host-cases.json', import.meta.url), 'utf8')) as { cases: HostCase[] };

function evaluate(c: HostCase): unknown {
	switch (c.fn) {
		case 'toPuny':
			return toPuny(c.host);
		case 'toPunyNullable':
			return toPunyNullable(c.host);
		case 'punyHost':
			return punyHost(c.url);
		case 'isSelfHost':
			return createHostRules(c.selfHost).isSelfHost(c.host);
		case 'fullApAccount':
			return createHostRules(c.selfHost).fullApAccount('alice', c.host);
		case 'isUriLocal':
			return createHostRules(c.selfHost).isUriLocal(c.url);
		case 'emojiHost': {
			// 本家のparseEmojiStrと同じ正規表現で分けたhost部分を渡す。
			const match = c.name.match(/^([-\w]+)(?:@([\w.-]+))?$/);
			if (!match) {
				throw new Error(`fixture is not an emoji name: ${c.name}`);
			}
			return createHostRules(c.selfHost).emojiHost(match[2], c.noteUserHost);
		}
	}
}

test('host fixture covers every recorded function', () => {
	expect(new Set(cases.map(c => c.fn))).toEqual(new Set(['toPuny', 'toPunyNullable', 'punyHost', 'isSelfHost', 'fullApAccount', 'isUriLocal', 'emojiHost']));
});

test.each(cases.map(c => [JSON.stringify(c), c] as const))('matches pinned upstream: %s', (_, c) => {
	expect(evaluate(c)).toEqual(c.expected);
});

test('punyHost rejects an invalid URL like upstream', () => {
	expect(() => punyHost('not a url')).toThrow(TypeError);
});
