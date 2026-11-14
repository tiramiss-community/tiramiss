/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createUrlPreview } from '../../src/modules/url-preview/preview.js';
import { createUrlPreviewApi } from '../../src/http/url-preview-api.js';
import { createPreviewFetcher } from '../../src/platform/url-preview.js';
import type { PreviewSettings, PreviewSummary } from '../../src/modules/url-preview/preview.js';
import type { SummalyOptions } from '@misskey-dev/summaly';

const state = vi.hoisted(() => ({ fetch: undefined as unknown as (url: string, options: unknown) => Promise<PreviewSummary> }));
vi.mock('@misskey-dev/summaly', () => ({ summaly: (url: string, options: unknown) => state.fetch(url, options) }));
interface Step {
	path: string; method?: string; settings?: Partial<PreviewSettings>; result?: object; delete?: string[];
	fail?: boolean; advance?: number; gc?: boolean;
}
const directory = new URL('../../../../docs/superpowers/compatibility/url-preview/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	defaults: { url: string; mediaProxy: string; settings: PreviewSettings; summary: PreviewSummary };
	cases: { id: string; steps: Step[] }[];
};
const observations = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as { cases: { id: string; steps: unknown[] }[] };
afterEach(() => vi.useRealTimers());

test('source comparison retains one observation per independent corpus case', () => {
	expect(new Set(corpus.cases.map(item => item.id)).size).toBe(corpus.cases.length);
	expect(observations.cases.map(item => item.id)).toEqual(corpus.cases.map(item => item.id));
});
test.each(corpus.cases)('$id matches literal pinned source handler/cache/acquisition options', async item => {
	vi.useFakeTimers();
	let clock = 0;
	const calls: unknown[] = [];
	let current: Step;
	const settings = structuredClone(corpus.defaults.settings);
	const result = () => {
		if (current.fail) {
			throw Error('injected acquisition failure');
		}
		const value = structuredClone({ ...corpus.defaults.summary, ...current.result });
		for (const key of current.delete ?? []) {
			delete (value as unknown as Record<string, unknown>)[key];
		}
		return value;
	};
	state.fetch = async (url, options) => {
		calls.push({ mode: 'direct', url, options }); return result(); 
	};
	const fetchSummary = createPreviewFetcher({
		url: corpus.defaults.url,
		agents: { http: 'HTTP', https: 'HTTPS' } as unknown as NonNullable<SummalyOptions['agent']>,
		getJson: async (url, accept, headers, allowLocalAddress) => {
			calls.push({ mode: 'proxy', url, accept, headers, allowLocalAddress }); return result();
		},
	});
	const preview = createUrlPreview({ readSettings: async () => settings, fetchSummary, mediaProxy: corpus.defaults.mediaProxy, now: () => clock });
	const app = createUrlPreviewApi(preview);
	const actual = [];
	try {
		for (const step of item.steps) {
			const before = calls.length;
			current = step; clock += step.advance ?? 0;
			Object.assign(settings, step.settings ?? {});
			if (step.gc) {
				vi.advanceTimersByTime(180000);
			}
			const response = await app.request(step.path, { method: step.method ?? 'GET' });
			const body = await response.text();
			actual.push({ status: response.status, cacheControl: response.headers.get('cache-control'), body: body ? JSON.parse(body) : '', calls: JSON.parse(JSON.stringify(calls.slice(before))) });
		}
		expect(actual).toEqual(observations.cases.find(observation => observation.id === item.id)!.steps);
	} finally {
		await preview.close(); 
	}
});
