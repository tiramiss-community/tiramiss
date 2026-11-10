/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function normalizeHashtag(tag: string): string {
	return tag.normalize('NFKC').toLowerCase();
}
