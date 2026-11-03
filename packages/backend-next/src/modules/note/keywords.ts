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

// cw と text は続けて読まれうるため、区切らずに連結する（本家 UtilityService.concatNoteContentsForKeyWordCheck）。
export function concatNoteContentsForKeywordCheck(content: { cw: string | null; text: string | null; pollChoices: string[] }): string {
	return `${content.cw ?? ''}${content.text ?? ''}\n${content.pollChoices.join('\n')}\n`;
}
