/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { join } from 'node:path';
import { Readable } from 'node:stream';
import send from '@fastify/send';
import { renderTwemojiBadge } from './twemoji-badge.js';
import type { EmojiImageAssets } from '../../http/emoji-images-api.js';

export function createEmojiImageAssets(directories: { fluentEmojiDir: string; twemojiDir: string }): EmojiImageAssets {
	return {
		async file(kind, name, request) {
			// Reuse the pinned static engine so ranges and cache preconditions keep their HTTP semantics.
			const result = await send(Object.assign(Readable.from([]), request), name, {
				root: kind === 'fluent' ? directories.fluentEmojiDir : directories.twemojiDir,
				maxAge: 2592000000,
			});
			if (result.type !== 'file') {
				result.stream.destroy();
				return { status: result.statusCode, headers: {}, ...(result.type === 'error' ? { error: result.metadata.error } : {}) };
			}
			if (request.method === 'HEAD' || result.statusCode === 304) {
				result.stream.destroy();
				return { status: result.statusCode, headers: result.headers };
			}
			return { status: result.statusCode, headers: result.headers, body: result.stream };
		},
		badge: name => renderTwemojiBadge(join(directories.twemojiDir, `${name.slice(0, -4)}.svg`)),
	};
}
