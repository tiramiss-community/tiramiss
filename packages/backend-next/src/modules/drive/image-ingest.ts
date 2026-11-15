/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { sharpBmp } from '@misskey-dev/sharp-read-bmp';
import { encode } from 'blurhash';
import { fileTypeFromBuffer } from 'file-type';
import isSvg from 'is-svg';
import probeImageSize from 'probe-image-size';
import sharp from 'sharp';
import type { Sharp, WebpOptions, AvifOptions } from 'sharp';

export type ImageByteInfo = {
	size: number;
	md5: string;
	type: { mime: string; ext: string | null };
	width?: number;
	height?: number;
	orientation?: number;
	blurhash?: string;
	warnings: string[];
};
export type DerivedImage = { data: Buffer; ext: 'webp' | 'avif' | 'png'; type: string };
export type ImageAlternates = { webpublic: DerivedImage | null; thumbnail: DerivedImage | null };

// Only the dictionary consumed by generateAlts is needed here. Other MIME
// categories belong to their consumers (proxy, browser-safe serving, inference).
const convertible = new Set(['image/jpeg', 'image/tiff', 'image/png', 'image/gif', 'image/apng', 'image/vnd.mozilla.apng', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon', 'image/bmp']);
export function isImageConvertible(mime: string): boolean {
	return convertible.has(mime);
}
const dimensionTypes = new Set(['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/avif', 'image/apng', 'image/bmp', 'image/tiff', 'image/svg+xml', 'image/vnd.adobe.photoshop']);
const blurhashTypes = new Set(['image/jpeg', 'image/gif', 'image/png', 'image/apng', 'image/webp', 'image/avif', 'image/svg+xml']);
const octetStream = { mime: 'application/octet-stream', ext: null };
const webpDefaults: WebpOptions = { quality: 77, alphaQuality: 95, lossless: false, nearLossless: false, smartSubsample: true, mixed: true, effort: 2, loop: 0 };
const avifDefaults: AvifOptions = { quality: 60, lossless: false, effort: 2 };

/** Image/file byte inspection; video-track probing and sensitivity are separate capabilities. */
export async function inspectImageBytes(bytes: Buffer, options: { fileName?: string | null } = {}): Promise<ImageByteInfo> {
	const warnings: string[] = [];
	const detected = bytes.length === 0 ? undefined : await fileTypeFromBuffer(bytes);
	const svg = () => bytes.length <= 1024 * 1024 && isSvg(bytes.toString());
	let type: ImageByteInfo['type'] = detected ? { mime: detected.mime, ext: detected.ext } : octetStream;
	if ((!detected || detected.mime === 'application/xml') && svg()) {
		type = { mime: 'image/svg+xml', ext: 'svg' };
	}
	if (type.mime === 'audio/x-flac') {
		type = { ...type, mime: 'audio/flac' };
	}
	if (type.mime === 'audio/vnd.wave') {
		type = { ...type, mime: 'audio/wav' };
	}
	if (type.mime === octetStream.mime && options.fileName != null) {
		const ext = options.fileName.split('.').pop();
		if (ext === 'txt') {
			type = { mime: 'text/plain', ext };
		}
		if (ext === 'csv') {
			type = { mime: 'text/csv', ext };
		}
		if (ext === 'json') {
			type = { mime: 'application/json', ext };
		}
	}
	let width: number | undefined;
	let height: number | undefined;
	let orientation: number | undefined;
	if (dimensionTypes.has(type.mime)) {
		const input = Readable.from([bytes]);
		const dimensions = await probeImageSize(input).catch((error: unknown) => {
			warnings.push(`detectImageSize failed: ${error}`);
			return undefined;
		}).finally(() => input.destroy());
		if (!dimensions) {
			warnings.push('cannot detect image dimensions');
			type = octetStream;
		} else if (dimensions.wUnits === 'px') {
			({ width, height, orientation } = dimensions);
			if (width > 16383 || height > 16383) {
				warnings.push('image dimensions exceeds limits');
				type = octetStream;
			}
		} else {
			warnings.push(`unsupported unit type: ${dimensions.wUnits}`);
		}
	}
	let blurhash: string | undefined;
	if (blurhashTypes.has(type.mime)) {
		try {
			const image = await sharpBmp(bytes, type.mime);
			const { data, info } = await image.raw().ensureAlpha().resize(64, 64, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
			// The source hashes the first frame in stored orientation, before autorotate.
			blurhash = encode(new Uint8ClampedArray(data), info.width, info.height, 5, 5);
		} catch (error) {
			warnings.push(`getBlurhash failed: ${error}`);
		}
	}
	return { size: bytes.length, md5: createHash('md5').update(bytes).digest('hex'), type, width, height, orientation, blurhash, warnings };
}

async function convert(image: Sharp, format: DerivedImage['ext'], width: number, height: number, webpOptions: WebpOptions = webpDefaults): Promise<DerivedImage> {
	const resized = image.resize(width, height, { fit: 'inside', withoutEnlargement: true }).rotate();
	const encoded = format === 'webp' ? resized.webp(webpOptions) : format === 'avif' ? resized.avif(avifDefaults) : resized.png();
	return { data: await encoded.toBuffer(), ext: format, type: `image/${format}` };
}

/** Resize without enlargement, strip metadata, resolve orientation, use the first frame. */
export function convertImageBytes(bytes: Buffer, format: DerivedImage['ext'], width: number, height: number): Promise<DerivedImage> {
	return convert(sharp(bytes), format, width, height);
}

/** Image branch of DriveService.generateAlts; failures omit only that alternate. */
export async function generateImageAlts(bytes: Buffer, mime: string, generateWeb: boolean): Promise<ImageAlternates> {
	const result: ImageAlternates = { webpublic: null, thumbnail: null };
	if (!isImageConvertible(mime)) {
		return result;
	}
	let image: Sharp;
	let animated: boolean;
	let satisfiesWebpublic: boolean;
	try {
		image = await sharpBmp(bytes, mime);
		const metadata = await image.metadata();
		animated = !!(metadata.pages && metadata.pages > 1);
		satisfiesWebpublic = !!(mime !== 'image/svg+xml' && mime !== 'image/avif' &&
			!(metadata.exif ?? metadata.iptc ?? metadata.xmp ?? metadata.tifftagPhotoshop) &&
			metadata.width && metadata.width <= 2048 && metadata.height && metadata.height <= 2048);
	} catch {
		return result;
	}
	if (generateWeb && !satisfiesWebpublic && !animated) {
		try {
			if (['image/jpeg', 'image/webp', 'image/avif'].includes(mime)) {
				result.webpublic = await convert(image, 'webp', 2048, 2048);
			} else if (['image/png', 'image/bmp', 'image/svg+xml'].includes(mime)) {
				result.webpublic = await convert(image, 'png', 2048, 2048);
			}
		} catch { /* The thumbnail attempt is independent. */ }
	}
	try {
		result.thumbnail = animated
			? await convert(sharp(bytes, { animated: true }), 'webp', 374, 317, { alphaQuality: 70 })
			: await convert(image, 'webp', 498, 422);
	} catch { /* The successful webpublic remains usable. */ }
	return result;
}
