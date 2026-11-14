/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { createUrlPreview } from '../../src/modules/url-preview/preview.js';
import { createUrlPreviewApi } from '../../src/http/url-preview-api.js';
import type { PreviewSettings, PreviewSummary } from '../../src/modules/url-preview/preview.js';

const settings: PreviewSettings = {
	urlPreviewEnabled: true, urlPreviewAllowRedirect: true, urlPreviewTimeout: 10000,
	urlPreviewMaximumContentLength: 10485760, urlPreviewRequireContentLength: false,
	urlPreviewSummaryProxyUrl: null, urlPreviewUserAgent: null, urlPreviewSensitiveList: [],
};
const summary = (): PreviewSummary => ({ url: 'https://result.test/path', title: 'title', player: { url: null }, icon: 'https://image.test/i?a=1&b=2', thumbnail: null });
const instances: ReturnType<typeof createUrlPreview>[] = [];
afterEach(async () => {
	await Promise.all(instances.splice(0).map(instance => instance.close()));
	vi.useRealTimers();
});

function fixture() {
	let now = 0;
	const meta = { ...settings, urlPreviewSensitiveList: [] as string[] };
	const fetchSummary = vi.fn(async () => summary());
	const readSettings = vi.fn(async () => meta);
	const preview = createUrlPreview({ readSettings, fetchSummary, mediaProxy: 'https://media.test', now: () => now });
	instances.push(preview);
	return { preview, app: createUrlPreviewApi(preview), fetchSummary, readSettings, meta, time: (value: number) => {
		now = value; 
	} };
}

test.each(['/url', '/url?url=a&url=b', '/url?url=a&lang=ja&lang=en'])('invalid query %s is rejected before reading Meta', async path => {
	const f = fixture();
	expect((await f.app.request(path)).status).toBe(400);
	expect(f.readSettings).not.toHaveBeenCalled();
});
test('disabled settings produce source error without acquisition or cache headers', async () => {
	const f = fixture(); f.meta.urlPreviewEnabled = false;
	const response = await f.app.request('/url?url=');
	expect(response.status).toBe(403);
	expect(response.headers.get('cache-control')).toBeNull();
	expect(await response.json()).toEqual({ error: { message: 'URL preview is disabled', code: 'URL_PREVIEW_DISABLED', id: '58b36e13-d2f5-0323-b0c6-76aa9dabefb8', kind: 'client' } });
	expect(f.fetchSummary).not.toHaveBeenCalled();
});
test('success wraps image URLs once and reevaluates sensitive settings on cached raw result', async () => {
	const f = fixture();
	const first = await f.app.request('/url?url=https://input.test');
	expect(first.status).toBe(200);
	expect(first.headers.get('cache-control')).toBe('max-age=86400, immutable');
	expect(await first.json()).toMatchObject({ sensitive: false, icon: 'https://media.test/preview.webp?url=https%3A%2F%2Fimage.test%2Fi%3Fa%3D1%26b%3D2&preview=1', thumbnail: null });
	f.meta.urlPreviewSensitiveList = ['result.test path'];
	const next = await f.preview.preview('https://input.test');
	expect(next.sensitive).toBe(true);
	expect(next.icon).not.toContain('url=https%3A%2F%2Fmedia.test');
	expect(f.fetchSummary).toHaveBeenCalledTimes(1);
});
test.each(['javascript:bad', 'HTTP://uppercase', 'file:///bad'])('invalid result URL %s returns 422 and is not cached', async url => {
	const f = fixture(); f.fetchSummary.mockResolvedValue({ ...summary(), url });
	for (let i = 0; i < 2; i++) {
		const response = await f.app.request('/url?url=x');
		expect(response.status).toBe(422);
		expect(response.headers.get('cache-control')).toBe('max-age=86400, immutable');
		expect(await response.json()).toEqual({ error: { message: 'Failed to get preview', code: 'URL_PREVIEW_FAILED', id: '09d01cb5-53b9-4856-82e5-38a50c290a3b', kind: 'client' } });
	}
	expect(f.fetchSummary).toHaveBeenCalledTimes(2);
});
test('invalid player URL and rejected acquisition become 422', async () => {
	const f = fixture(); f.fetchSummary.mockResolvedValueOnce({ ...summary(), player: { url: 'data:text/html,bad' } }).mockRejectedValueOnce(new Error('timeout'));
	expect((await f.app.request('/url?url=x')).status).toBe(422);
	expect((await f.app.request('/url?url=x')).status).toBe(422);
});
test('cache separates omitted and explicit language, survives equality and expires beyond one hour', async () => {
	const f = fixture();
	await f.preview.preview('x'); await f.preview.preview('x', 'ja-JP'); await f.preview.preview('x', '');
	expect(f.fetchSummary).toHaveBeenCalledTimes(3);
	f.time(3600000); await f.preview.preview('x'); expect(f.fetchSummary).toHaveBeenCalledTimes(3);
	f.time(3600001); await f.preview.preview('x'); expect(f.fetchSummary).toHaveBeenCalledTimes(4);
});
test('100-entry cache refreshes access order, and does not merge concurrent misses', async () => {
	const f = fixture();
	for (let i = 0; i < 100; i++) {
		await f.preview.preview(String(i));
	}
	await f.preview.preview('0'); await f.preview.preview('100'); await f.preview.preview('0');
	expect(f.fetchSummary).toHaveBeenCalledTimes(101);
	await f.preview.preview('1'); expect(f.fetchSummary).toHaveBeenCalledTimes(102);
	await Promise.all([f.preview.preview('new'), f.preview.preview('new')]);
	expect(f.fetchSummary).toHaveBeenCalledTimes(104);
});
test('source sensitive rules include RE2 regex, AND words and sticky true', async () => {
	const f = fixture();
	f.meta.urlPreviewSensitiveList = ['/RESULT/i']; expect((await f.preview.preview('x')).sensitive).toBe(true);
	f.meta.urlPreviewSensitiveList = ['result missing', '/[/']; expect((await f.preview.preview('x')).sensitive).toBe(false);
	f.fetchSummary.mockResolvedValue({ ...summary(), sensitive: true }); expect((await f.preview.preview('sticky')).sensitive).toBe(true);
});
test('close releases the periodic cache timer and waits for pending acquisitions', async () => {
	vi.useFakeTimers();
	const baseline = vi.getTimerCount(); const f = fixture();
	expect(vi.getTimerCount()).toBe(baseline + 1);
	let release!: (value: PreviewSummary) => void;
	f.fetchSummary.mockImplementation(() => new Promise(resolve => {
		release = resolve; 
	}));
	const pending = f.preview.preview('x'); await Promise.resolve();
	let closed = false; const closing = f.preview.close().then(() => {
		closed = true; 
	});
	await Promise.resolve(); expect(closed).toBe(false);
	release(summary()); await pending; await closing;
	expect(vi.getTimerCount()).toBe(baseline);
});
