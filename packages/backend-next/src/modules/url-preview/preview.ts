/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { matchesWords } from '../note/public.js';

export interface PreviewSettings {
	urlPreviewEnabled: boolean;
	urlPreviewAllowRedirect: boolean;
	urlPreviewTimeout: number;
	urlPreviewMaximumContentLength: number;
	urlPreviewRequireContentLength: boolean;
	urlPreviewSummaryProxyUrl: string | null;
	urlPreviewUserAgent: string | null;
	urlPreviewSensitiveList: string[];
}
export interface PreviewSummary {
	url: string;
	player: { url: string | null };
	title?: string | null;
	icon?: string | null;
	thumbnail?: string | null;
	sensitive?: boolean;
}
export class PreviewDisabled extends Error {}
export class PreviewFailed extends Error {}

export function createUrlPreview(ports: {
	readSettings(): Promise<PreviewSettings>;
	fetchSummary(url: string, lang: string | undefined, settings: PreviewSettings): Promise<PreviewSummary>;
	mediaProxy: string;
	now(): number;
}) {
	const lifetime = 3600000;
	const cache = new Map<string, { date: number; value: PreviewSummary }>();
	const pending = new Set<Promise<PreviewSummary>>();
	let closing = false;
	const gc = () => {
		for (const [key, entry] of cache) {
			if (ports.now() - entry.date >= lifetime) {
				cache.delete(key);
			}
		}
	};
	const timer = setInterval(gc, 180000);
	const wrap = (url?: string | null) => url != null
		? `${ports.mediaProxy}/preview.webp?url=${encodeURIComponent(url)}&preview=1`
		: null;
	const validUrl = (url: string) => url.startsWith('http://') || url.startsWith('https://');
	const execute = async (url: string, lang?: string) => {
		const settings = await ports.readSettings();
		if (!settings.urlPreviewEnabled) {
			throw new PreviewDisabled();
		}
		try {
			const key = `${url}@${lang ?? '_DEFAULT_'}`;
			let entry = cache.get(key);
			if (entry && ports.now() - entry.date > lifetime) {
				cache.delete(key); entry = undefined;
			}
			let raw: PreviewSummary;
			if (entry) {
				cache.delete(key); cache.set(key, entry);
				raw = entry.value;
			} else {
				raw = await ports.fetchSummary(url, lang, settings);
				if (!validUrl(raw.url) || (raw.player.url && !validUrl(raw.player.url))) {
					throw new Error('Invalid summary');
				}
				gc(); cache.delete(key);
				while (cache.size >= 100) {
					cache.delete(cache.keys().next().value!);
				}
				cache.set(key, { date: ports.now(), value: raw });
			}
			const summary = structuredClone(raw);
			summary.icon = wrap(summary.icon);
			summary.thumbnail = wrap(summary.thumbnail);
			if (summary.sensitive !== true) {
				summary.sensitive = matchesWords(summary.url, settings.urlPreviewSensitiveList);
			}
			return summary;
		} catch (cause) {
			throw new PreviewFailed('Failed to get preview', { cause });
		}
	};
	return {
		preview(url: string, lang?: string): Promise<PreviewSummary> {
			if (closing) {
				return Promise.reject(new PreviewFailed('Preview is closing'));
			}
			const work = execute(url, lang);
			pending.add(work);
			void work.finally(() => pending.delete(work)).catch(() => {});
			return work;
		},
		async close() {
			closing = true;
			clearInterval(timer);
			await Promise.allSettled([...pending]);
			cache.clear();
		},
	};
}
