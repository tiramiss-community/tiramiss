/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { inspectImageBytes, convertImageBytes, generateImageAlts, isImageConvertible } from '../../../src/modules/drive/image-ingest.js';
import type { DerivedImage } from '../../../src/modules/drive/image-ingest.js';

const dir = new URL('../../../../../docs/superpowers/compatibility/image-ingest/', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', dir), 'utf8')).fixtures as { id: string; base64: string; fileName?: string }[];
const observations = JSON.parse(readFileSync(new URL('observations.json', dir), 'utf8'));
const bytes = (id: string) => Buffer.from(fixtures.find(f => f.id === id)!.base64, 'base64');
const normalize = (v: unknown) => JSON.parse(JSON.stringify(v));

async function readImage(image: DerivedImage | null) {
	if (!image) {
		return null;
	}
	const m = await sharp(image.data, { animated: true }).metadata();
	const { data, info } = await sharp(image.data, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	let alphaMin = 255, alphaMax = 0;
	for (let i = info.channels - 1; i < data.length; i += info.channels) {
		alphaMin = Math.min(alphaMin, data[i]);
		alphaMax = Math.max(alphaMax, data[i]);
	}
	return normalize({ type: image.type, ext: image.ext, format: m.format, width: m.width, height: m.height, pages: m.pages ?? 1, pageHeight: m.pageHeight ?? m.height, hasAlpha: m.hasAlpha, alphaMin, alphaMax, delay: m.delay, loop: m.loop, orientation: m.orientation, hasMetadata: !!(m.exif || m.iptc || m.xmp || m.tifftagPhotoshop) });
}

for (const f of fixtures) {
	const expected = observations.cases.find((c: { id: string }) => c.id === f.id);
	if (expected.infoError) {
		test(`propagates file-type failure for ${f.id} like the source`, async () => {
			await expect(inspectImageBytes(bytes(f.id))).rejects.toMatchObject(expected.infoError);
		});
		continue;
	}
	test(`inspects fixed ${f.id} bytes against pinned FileInfoService`, async () => {
		const actual = await inspectImageBytes(Buffer.from(f.base64, 'base64'), { fileName: f.fileName });
		// Native sharp identifies its input as buffer instead of file; warning category is unchanged.
		actual.warnings = actual.warnings.map(w => w.replace('Input buffer', 'Input file'));
		const { sensitive: _sensitive, porn: _porn, ...info } = expected.info;
		expect(normalize(actual)).toEqual(info);
	});
	for (const alts of expected.alts) {
		test(`reads actual ${f.id} alternate outputs (web=${alts.generateWeb})`, async () => {
		const result = await generateImageAlts(Buffer.from(f.base64, 'base64'), expected.info.type.mime, alts.generateWeb);
		expect(await readImage(result.webpublic)).toEqual(alts.webpublic);
			expect(await readImage(result.thumbnail)).toEqual(alts.thumbnail);
		});
	}
	for (const c of expected.conversions) {
		test(`converts ${f.id} to ${c.format} with source orientation/alpha/first frame`, async () => {
			expect(await readImage(await convertImageBytes(bytes(f.id), c.format, 5, 4))).toEqual(c.expected);
		});
	}
}
for (const [mime, expected] of Object.entries(observations.mimeClassification)) {
	test(`classifies consumed MIME ${mime}`, () => {
		expect(isImageConvertible(mime)).toBe(expected);
	});
}

test('rejects direct conversion failures while alternate generation omits the failed result', async () => {
	await expect(convertImageBytes(bytes('corrupt-jpeg'), 'png', 5, 4)).rejects.toThrow();
	expect(await generateImageAlts(bytes('corrupt-jpeg'), 'image/jpeg', true)).toEqual({ webpublic: null, thumbnail: null });
});
test('continues thumbnail generation when webpublic pipeline validation fails', async () => {
	const original = sharp.prototype.png;
	const failure = vi.spyOn(sharp.prototype, 'png').mockImplementationOnce(function (this: Sharp) {
		return original.call(this.resize(0, 0));
	});
	try {
		const result = await generateImageAlts(bytes('svg'), 'image/svg+xml', true);
		expect(result.webpublic).toBeNull();
		expect(await readImage(result.thumbnail)).toEqual(observations.failures.find((f: { stage: string }) => f.stage === 'webpublic').thumbnail);
	} finally {
		failure.mockRestore();
	}
});
test('keeps successful webpublic when thumbnail pipeline validation fails', async () => {
	const failure = vi.spyOn(sharp.prototype, 'webp').mockImplementationOnce(function (this: Sharp) {
		return this.resize(0, 0);
	});
	try {
		const result = await generateImageAlts(bytes('svg'), 'image/svg+xml', true);
		expect(await readImage(result.webpublic)).toEqual(observations.failures.find((f: { stage: string }) => f.stage === 'thumbnail').webpublic);
		expect(result.thumbnail).toBeNull();
	} finally {
		failure.mockRestore();
	}
});
