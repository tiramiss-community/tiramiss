/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as mfm from 'mfm-js';

export interface MentionToken {
	username: string;
	host: string | null;
}

export interface ExtractedContents {
	// 保存する値（正規化済み）。
	tags: string[];
	emojis: string[];
	// 出現順のまま。重複は解決後にユーザー ID で除く。
	mentions: MentionToken[];
}

// 本家 misc/normalize-for-search.ts。
function normalizeForSearch(tag: string): string {
	return tag.normalize('NFKC').toLowerCase();
}

// 本家 NoteCreateService.ts:585-609,661 と misc/extract-{hashtags,custom-emojis-from-mfm,mentions}.ts。
// 長さの上限は正規化前の値で判定する。正規化で伸びるタグは保存時に DB の長さ制限で失敗するが、本家と同じ結果にするため事前に除かない。
export function extractNoteContents(
	contents: { text: string | null; cw: string | null; pollChoices: string[] },
	skip: { mentions: boolean; hashtags: boolean; emojis: boolean },
): ExtractedContents {
	if (skip.mentions && skip.hashtags && skip.emojis) {
		return { tags: [], emojis: [], mentions: [] };
	}
	const tokens = [
		...(contents.text ? mfm.parse(contents.text) : []),
		...(contents.cw ? mfm.parse(contents.cw) : []),
		...contents.pollChoices.flatMap(choice => mfm.parse(choice)),
	];

	const hashtags = skip.hashtags ? [] : (mfm.extract(tokens, node => node.type === 'hashtag') as mfm.MfmHashtag[]).map(node => node.props.hashtag);
	const emojis = skip.emojis ? [] : (mfm.extract(tokens, node => node.type === 'emojiCode' && node.props.name.length <= 100) as mfm.MfmEmojiCode[]).map(node => node.props.name);
	const mentions = skip.mentions ? [] : (mfm.extract(tokens, node => node.type === 'mention') as mfm.MfmMention[]).map(node => ({ username: node.props.username, host: node.props.host }));

	return {
		tags: [...new Set(hashtags)].filter(tag => Array.from(tag).length <= 128).slice(0, 32).map(normalizeForSearch),
		emojis: [...new Set(emojis)],
		mentions,
	};
}
