/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { URL } from 'node:url';
import * as htmlParser from 'node-html-parser';
const normalizeForSearch = (value: string) => value.normalize('NFKC').toLowerCase();
const urlRegex = /^https?:\/\/[\w\/:%#@$&?!()\[\]~.,=+\-]+/;
const urlRegexFull = /^https?:\/\/[\w\/:%#@$&?!()\[\]~.,=+\-]+$/;

export function htmlToMfm(html: string, hashtagNames?: string[]): string {
	// some AP servers like Pixelfed use br tags as well as newlines
	html = html.replace(/<br\s?\/?>\r?\n/gi, '\n');

	const normalizedHashtagNames = hashtagNames == null ? undefined : new Set<string>(hashtagNames.map(x => normalizeForSearch(x)));

	const doc = htmlParser.parse(`<div>${html}</div>`);

	let text = '';

	for (const n of doc.childNodes) {
		analyze(n);
	}

	return text.trim();

	function getText(node: htmlParser.Node): string {
		if (node instanceof htmlParser.TextNode) {
			return node.textContent;
		}
		if (!(node instanceof htmlParser.HTMLElement)) {
			return '';
		}
		if (node.tagName === 'BR') {
			return '\n';
		}

		if (node.childNodes != null) {
			return node.childNodes.map(n => getText(n)).join('');
		}

		return '';
	}

	function analyzeChildren(childNodes: htmlParser.Node[] | null): void {
		if (childNodes != null) {
			for (const n of childNodes) {
				analyze(n);
			}
		}
	}

	function analyze(node: htmlParser.Node) {
		if (node instanceof htmlParser.TextNode) {
			text += node.textContent;
			return;
		}

		// Skip comment or document type node
		if (!(node instanceof htmlParser.HTMLElement)) {
			return;
		}

		switch (node.tagName) {
			case 'BR': {
				text += '\n';
				break;
			}

			case 'A': {
				const txt = getText(node);
				const rel = node.attributes.rel;
				const href = node.attributes.href;

				// ハッシュタグ
				if (normalizedHashtagNames && href != null && normalizedHashtagNames.has(normalizeForSearch(txt))) {
					text += txt;
					// メンション
				} else if (txt.startsWith('@') && !(rel != null && rel.startsWith('me '))) {
					const part = txt.split('@');

					if (part.length === 2 && href) {
						//#region ホスト名部分が省略されているので復元する
						const acct = `${txt}@${(new URL(href)).hostname}`;
						text += acct;
						//#endregion
					} else if (part.length === 3) {
						text += txt;
					}
					// その他
				} else {
					const generateLink = () => {
						if (!href && !txt) {
							return '';
						}
						if (!href) {
							return txt;
						}
						if (!txt || txt === href) {	// #6383: Missing text node
							if (href.match(urlRegexFull)) {
								return href;
							} else {
								return `<${href}>`;
							}
						}
						if (href.match(urlRegex) && !href.match(urlRegexFull)) {
							return `[${txt}](<${href}>)`;	// #6846
						} else {
							return `[${txt}](${href})`;
						}
					};

					text += generateLink();
				}
				break;
			}

			case 'H1': {
				text += '【';
				analyzeChildren(node.childNodes);
				text += '】\n';
				break;
			}

			case 'B':
			case 'STRONG': {
				text += '**';
				analyzeChildren(node.childNodes);
				text += '**';
				break;
			}

			case 'SMALL': {
				text += '<small>';
				analyzeChildren(node.childNodes);
				text += '</small>';
				break;
			}

			case 'S':
			case 'DEL': {
				text += '~~';
				analyzeChildren(node.childNodes);
				text += '~~';
				break;
			}

			case 'I':
			case 'EM': {
				text += '<i>';
				analyzeChildren(node.childNodes);
				text += '</i>';
				break;
			}

			case 'RUBY': {
				let ruby: [string, string][] = [];
				for (const child of node.childNodes) {
					if ((child instanceof htmlParser.TextNode) && !/\s|\[|\]/.test(child.textContent)) {
						ruby.push([child.textContent, '']);
						continue;
					}

					if (!(child instanceof htmlParser.HTMLElement)) {
						continue;
					}

					if (child.tagName === 'RP') {
						continue;
					}

					if (child.tagName === 'RT' && ruby.length > 0) {
						const rt = getText(child);
						if (/\s|\[|\]/.test(rt)) {
							// If any space is included in rt, it is treated as a normal text
							ruby = [];
							analyzeChildren(node.childNodes);
							break;
						} else {
							ruby.at(-1)![1] = rt;
							continue;
						}
					}
					// If any other element is included in ruby, it is treated as a normal text
					ruby = [];
					analyzeChildren(node.childNodes);
					break;
				}
				for (const [base, rt] of ruby) {
					text += `$[ruby ${base} ${rt}]`;
				}
				break;
			}

			// block code (<pre><code>)
			case 'PRE': {
				if (node.childNodes.length === 1 && (node.childNodes[0] instanceof htmlParser.HTMLElement) && node.childNodes[0].tagName === 'CODE') {
					text += '\n```\n';
					text += getText(node.childNodes[0]);
					text += '\n```\n';
				} else if (node.childNodes.length === 1 && (node.childNodes[0] instanceof htmlParser.TextNode) && node.childNodes[0].textContent.startsWith('<code>') && node.childNodes[0].textContent.endsWith('</code>')) {
					text += '\n```\n';
					text += node.childNodes[0].textContent.slice(6, -7);
					text += '\n```\n';
				} else {
					analyzeChildren(node.childNodes);
				}
				break;
			}

			// inline code (<code>)
			case 'CODE': {
				text += '`';
				analyzeChildren(node.childNodes);
				text += '`';
				break;
			}

			case 'BLOCKQUOTE': {
				const t = getText(node);
				if (t) {
					text += '\n> ';
					text += t.split('\n').join('\n> ');
				}
				break;
			}

			case 'P':
			case 'H2':
			case 'H3':
			case 'H4':
			case 'H5':
			case 'H6': {
				text += '\n\n';
				analyzeChildren(node.childNodes);
				break;
			}

			// other block elements
			case 'DIV':
			case 'HEADER':
			case 'FOOTER':
			case 'ARTICLE':
			case 'LI':
			case 'DT':
			case 'DD': {
				text += '\n';
				analyzeChildren(node.childNodes);
				break;
			}

			default:	// includes inline elements
				{
					analyzeChildren(node.childNodes);
					break;
				}
		}
	}
}

