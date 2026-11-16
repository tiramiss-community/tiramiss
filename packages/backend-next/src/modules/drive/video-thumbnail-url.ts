/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function getExternalVideoThumbnailUrl(url: string, generator: string | null | undefined): string | null {
	if (generator == null) {
		return null;
	}
	const base = `${generator}/thumbnail.webp`;
	return `${base}${base.includes('?') ? base.endsWith('?') ? '' : '&' : '?'}thumbnail=1&url=${encodeURIComponent(url)}`;
}
