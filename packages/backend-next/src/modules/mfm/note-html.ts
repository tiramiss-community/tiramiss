/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as mfm from 'mfm-js';
import { toHtml } from './to-html.js';
import type { MentionedRemoteUser } from './to-html.js';

const plainNodeTypes = new Set<mfm.MfmNode['type']>(['text', 'unicodeEmoji', 'emojiCode', 'mention', 'hashtag', 'url']);

/**
 * 本家 ApMfmService.getNoteHtml。投稿の本文を AP の content にする。
 * `noMisskeyContent` が true なら、受け手は HTML だけで本文を再現できるため `_misskey_content`・`source` を付けない。
 */
export function getNoteHtml(
	note: { text: string | null; mentionedRemoteUsers: readonly MentionedRemoteUser[] },
	selfUrl: string,
	extraHtml: string | null = null,
): { content: string; noMisskeyContent: boolean } {
	const parsed = mfm.parse(note.text ?? '');
	// 入れ子を見ずに最上位のノードだけで判定する本家の規則。
	const noMisskeyContent = extraHtml == null && parsed.every(node => plainNodeTypes.has(node.type));
	const content = toHtml(parsed, { selfUrl, mentionedRemoteUsers: note.mentionedRemoteUsers }, extraHtml);
	return { content, noMisskeyContent };
}
