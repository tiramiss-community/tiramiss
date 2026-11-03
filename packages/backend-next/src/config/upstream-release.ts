/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 互換の対象とする固定本家。commit は backend-upstream/upstream-sync.json と一致させる。
 * 本家は version をビルド時の built/meta.json（ルート package.json の version）から読む。
 * backend-next は本家をビルドしないため、固定本家のルート package.json の値を写す。
 */
export const upstreamRelease = {
	commit: '8e07cf085adf7009583d234a208e30436f020e26',
	version: '2026.10.1-alpha.0',
} as const;
