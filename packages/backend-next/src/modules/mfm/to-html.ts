/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type * as mfm from 'mfm-js';

/** 本家 Note.mentionedRemoteUsers の要素。`url` はプロフィールに無ければ保存時に省かれる。 */
export interface MentionedRemoteUser {
	uri: string;
	url?: string;
	username: string;
	host: string;
}

/** 本家 misc/escape-html.ts。 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * 本家 MfmService.toHtml（固定コミットの core/MfmService.ts:273-437）。
 * 投稿の AP 表現の content になる。全体を `<p>` で包まず、`extraHtml` は末尾へそのまま足す。
 */
export function toHtml(
	nodes: mfm.MfmNode[],
	context: { selfUrl: string; mentionedRemoteUsers: readonly MentionedRemoteUser[] },
	extraHtml: string | null = null,
): string {
	const { selfUrl, mentionedRemoteUsers } = context;

	function children(nodes?: mfm.MfmNode[]): string {
		if (nodes == null) {
			return '';
		}
		return nodes.map(render).join('');
	}

	function fnDefault(node: mfm.MfmFn): string {
		return `<i>${children(node.children)}</i>`;
	}

	function fn(node: mfm.MfmFn): string {
		switch (node.props.name) {
			case 'unixtime': {
				const text = node.children[0].type === 'text' ? node.children[0].props.text : '';
				try {
					const date = new Date(parseInt(text, 10) * 1000);
					return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toISOString())}</time>`;
				} catch {
					return fnDefault(node);
				}
			}

			case 'ruby': {
				if (node.children.length === 1) {
					const child = node.children[0];
					const text = child.type === 'text' ? child.props.text : '';
					// 1 語だけ・文字列でない子 1 つのとき、本家は undefined を escapeHtml へ渡して TypeError を投げ、投稿は配送されない。
					// 空の rt で補うと本家が送らない HTML を送ることになるため、同じ例外にする。
					const [base, rt] = text.split(' ') as [string, string];
					return `<ruby>${escapeHtml(base)}<rp>(</rp><rt>${escapeHtml(rt)}</rt><rp>)</rp></ruby>`;
				}

				const rt = node.children.at(-1);
				if (!rt) {
					return fnDefault(node);
				}
				const text = rt.type === 'text' ? rt.props.text : '';
				return `<ruby>${children(node.children.slice(0, node.children.length - 1))}<rp>(</rp><rt>${escapeHtml(text.trim())}</rt><rp>)</rp></ruby>`;
			}

			default: {
				return fnDefault(node);
			}
		}
	}

	function mention(node: mfm.MfmMention): string {
		const { username, host, acct } = node.props;
		const remoteUser = mentionedRemoteUsers.find(user => user.username.toLowerCase() === username.toLowerCase() && user.host?.toLowerCase() === host?.toLowerCase());
		const href = remoteUser
			? (remoteUser.url ? remoteUser.url : remoteUser.uri)
			: `${selfUrl}/${acct.endsWith(`@${selfUrl}`) ? acct.substring(0, acct.length - selfUrl.length - 1) : acct}`;
		try {
			const url = new URL(href);
			return `<a href="${escapeHtml(url.href)}" class="u-url mention">${escapeHtml(acct)}</a>`;
		} catch {
			return escapeHtml(acct);
		}
	}

	function text(node: mfm.MfmText): string {
		if (!node.props.text.match(/[\r\n]/)) {
			return escapeHtml(node.props.text);
		}
		return node.props.text.split(/\r\n|\r|\n/).map(escapeHtml).join('<br />');
	}

	function render(node: mfm.MfmNode): string {
		switch (node.type) {
			case 'bold': {
				return `<b>${children(node.children)}</b>`;
			}
			case 'small': {
				return `<small>${children(node.children)}</small>`;
			}
			case 'strike': {
				return `<del>${children(node.children)}</del>`;
			}
			case 'italic': {
				return `<i>${children(node.children)}</i>`;
			}
			case 'fn': {
				return fn(node);
			}
			case 'blockCode': {
				return `<pre><code>${escapeHtml(node.props.code)}</code></pre>`;
			}
			case 'center': {
				return `<div style="text-align: center;">${children(node.children)}</div>`;
			}
			case 'emojiCode': {
				return `\u200B:${escapeHtml(node.props.name)}:\u200B`;
			}
			case 'unicodeEmoji': {
				return node.props.emoji;
			}
			case 'hashtag': {
				return `<a href="${escapeHtml(`${selfUrl}/tags/${encodeURIComponent(node.props.hashtag)}`)}" rel="tag">#${escapeHtml(node.props.hashtag)}</a>`;
			}
			case 'inlineCode': {
				return `<code>${escapeHtml(node.props.code)}</code>`;
			}
			case 'mathInline': {
				return `<code>${escapeHtml(node.props.formula)}</code>`;
			}
			case 'mathBlock': {
				return `<pre><code>${escapeHtml(node.props.formula)}</code></pre>`;
			}
			case 'link': {
				try {
					const url = new URL(node.props.url);
					return `<a href="${escapeHtml(url.href)}">${children(node.children)}</a>`;
				} catch {
					return `[${children(node.children)}](${escapeHtml(node.props.url)})`;
				}
			}
			case 'mention': {
				return mention(node);
			}
			case 'quote': {
				return `<blockquote>${children(node.children)}</blockquote>`;
			}
			case 'text': {
				return text(node);
			}
			case 'url': {
				try {
					const url = new URL(node.props.url);
					return `<a href="${escapeHtml(url.href)}">${escapeHtml(node.props.url)}</a>`;
				} catch {
					return escapeHtml(node.props.url);
				}
			}
			case 'search': {
				return `<a href="${escapeHtml(`https://www.google.com/search?q=${encodeURIComponent(node.props.query)}`)}">${escapeHtml(node.props.content)}</a>`;
			}
			case 'plain': {
				return `<span>${children(node.children)}</span>`;
			}
		}
	}

	return `${children(nodes)}${extraHtml ?? ''}`;
}
