/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { SummalyOptions } from '@misskey-dev/summaly';
import type { OutboundGetJson } from '../application/outbound-http.js';
import type { PreviewSettings, PreviewSummary } from '../modules/url-preview/public.js';

export function createPreviewFetcher(options: {
	url: string;
	agents: NonNullable<SummalyOptions['agent']>;
	getJson: OutboundGetJson;
}) {
	const defaultUserAgent = `SummalyBot/5.5.2 (${options.url}; +https://github.com/misskey-dev/summaly/blob/master/README.md)`;
	return async (url: string, lang: string | undefined, settings: PreviewSettings): Promise<PreviewSummary> => {
		const parameters = {
			lang: lang ?? 'ja-JP',
			followRedirects: settings.urlPreviewAllowRedirect,
			userAgent: settings.urlPreviewUserAgent ?? defaultUserAgent,
			operationTimeout: settings.urlPreviewTimeout,
			contentLengthLimit: settings.urlPreviewMaximumContentLength,
			contentLengthRequired: settings.urlPreviewRequireContentLength,
		};
		if (settings.urlPreviewSummaryProxyUrl) {
			const query = Object.entries({ url, ...parameters }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
			return await options.getJson(`${settings.urlPreviewSummaryProxyUrl}?${query}`, 'application/json, */*', undefined, true) as PreviewSummary;
		}
		const { summaly } = await import('@misskey-dev/summaly');
		return await summaly(url, { ...parameters, agent: options.agents });
	};
}
