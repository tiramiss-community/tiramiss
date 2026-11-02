/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import RE2 from 're2';

export function matchesWords(text: string, words: string[]): boolean {
	if (text === '') {
		return false;
	}
	return words.some(filter => {
		const regexp = filter.match(/^\/(.+)\/(.*)$/);
		if (!regexp) {
			return filter.split(' ').every(word => text.includes(word));
		}
		try {
			return new RE2(regexp[1], regexp[2]).test(text);
		} catch {
			return false;
		}
	});
}
