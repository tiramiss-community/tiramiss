/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import FFmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { expect, test, vi } from 'vitest';
import { generateVideoThumbnail, generateVideoAlts } from '../../../src/modules/drive/video-ingest.js';
import { renderDriveFile } from '../../../src/modules/drive/file-view.js';
import { getExternalVideoThumbnailUrl } from '../../../src/modules/drive/video-thumbnail-url.js';
import { extractVideoFrame } from '../../../src/platform/video/ffmpeg-frame.js';
import type { DerivedImage } from '../../../src/modules/drive/image-ingest.js';

const directory = new URL('../../../../../docs/superpowers/compatibility/video-ingest/', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', directory), 'utf8')).fixtures as { id: string; base64: string }[];
const observations = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8'));
const bytes = (id: string) => Buffer.from(fixtures.find(f => f.id === id)!.base64, 'base64');
const pending = async () => (await readdir(tmpdir())).filter(name => name.startsWith('misskey-video-')).sort();

async function describe(image: DerivedImage | null) {
	if (!image) {
		return null;
	}
	const metadata = await sharp(image.data).metadata();
	const { data } = await sharp(image.data).resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { type: image.type, ext: image.ext, format: metadata.format, width: metadata.width, height: metadata.height, rgb: [...data], hasMetadata: !!(metadata.exif || metadata.iptc || metadata.xmp) };
}

function expectImage(actual: Awaited<ReturnType<typeof describe>>, expected: Awaited<ReturnType<typeof describe>>) {
	if (!expected || !actual) {
		expect(actual).toEqual(expected);
		return;
	}
	const { rgb, ...metadata } = actual;
	const { rgb: expectedRgb, ...expectedMetadata } = expected;
	expect(metadata).toEqual(expectedMetadata);
	// FFmpeg distributions can round YUV-to-RGB channels differently.
	for (const [index, channel] of rgb.entries()) {
		expect(Math.abs(channel - expectedRgb[index])).toBeLessThanOrEqual(3);
	}
}

for (const fixture of fixtures) {
	const expected = observations.cases.find((c: { id: string }) => c.id === fixture.id);
	test(`real ${fixture.id} bytes match pinned video thumbnail and clean temporary files`, async () => {
		const before = await pending();
		if (expected.rejects) {
			await expect(generateVideoThumbnail(bytes(fixture.id), extractVideoFrame)).rejects.toThrow();
		} else {
			expectImage(await describe(await generateVideoThumbnail(bytes(fixture.id), extractVideoFrame)), expected.thumbnail);
		}
		expect(await pending()).toEqual(before);
	});

	test(`Drive local/external video branches match pinned ${fixture.id}`, async () => {
		const result = await generateVideoAlts(bytes(fixture.id), undefined, extractVideoFrame);
		expect(result.webpublic).toBe(expected.local.webpublic);
		expectImage(await describe(result.thumbnail), expected.local.thumbnail);
		for (const generator of ['', 'https://video.test']) {
			const unexpected = vi.fn(() => {
				throw Error('external generator must skip local work');
			});
			expect(await generateVideoAlts(bytes(fixture.id), generator, unexpected)).toEqual(expected.external);
			expect(unexpected).not.toHaveBeenCalled();
		}
	});
}

for (const expected of observations.urls) {
	test(`external generator URL matches pinned query semantics: ${expected.generator}`, () => {
		expect(getExternalVideoThumbnailUrl('https://file.test/a b.mp4?x=1&y=日本#frame', expected.generator)).toBe(expected.url);
		const file = { id: 'video', userId: null, userHost: null, uri: null, isLink: false, folderId: null, name: 'video.mp4', type: 'video/mp4', md5: '', size: 1, isSensitive: false, blurhash: null, properties: {}, thumbnailUrl: null, comment: null, webpublicAccessKey: null, webpublicUrl: null, url: 'https://file.test/a b.mp4?x=1&y=日本#frame' };
		expect(renderDriveFile(file, false, { url: 'https://server.test', videoThumbnailGenerator: expected.generator, createdAtFromId: () => 0 }).thumbnailUrl).toBe(expected.url);
	});
}

test('propagates child process failure, omits failed alternate and awaits cleanup', async () => {
	const before = await pending();
	const directory = await mkdtemp(join(tmpdir(), 'ffmpeg-failure-281-'));
	const executable = join(directory, 'fail');
	const original = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
	await writeFile(executable, '#!/bin/sh\nexit 17\n', { mode: 0o700 });
	FFmpeg.setFfmpegPath(executable);
	try {
		await expect(generateVideoThumbnail(bytes('landscape-phases'), extractVideoFrame)).rejects.toThrow(/17/);
		expect(await generateVideoAlts(bytes('landscape-phases'), undefined, extractVideoFrame)).toEqual({ webpublic: null, thumbnail: null });
		expect(await pending()).toEqual(before);
	} finally {
		FFmpeg.setFfmpegPath(original);
		await rm(directory, { recursive: true, force: true });
	}
});

test('cleans frame files before a failed WebP conversion returns to caller', async () => {
	const before = await pending();
	const failure = vi.spyOn(sharp.prototype, 'webp').mockImplementationOnce(() => {
		throw Error('encoder failed');
	});
	try {
		await expect(generateVideoThumbnail(bytes('landscape-phases'), extractVideoFrame)).rejects.toThrow('encoder failed');
		expect(await pending()).toEqual(before);
	} finally {
		failure.mockRestore();
	}
});
