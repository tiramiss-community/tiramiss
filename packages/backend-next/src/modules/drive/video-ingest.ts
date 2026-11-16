/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { convertImageBytes } from './image-ingest.js';
import type { DerivedImage, ImageAlternates } from './image-ingest.js';

export type VideoFrameExtractor = (bytes: Buffer) => Promise<Buffer>;

export async function generateVideoThumbnail(bytes: Buffer, extractFrame: VideoFrameExtractor): Promise<DerivedImage> {
	return convertImageBytes(await extractFrame(bytes), 'webp', 498, 422);
}

/** Video branch of DriveService.generateAlts; a failed thumbnail is optional. */
export async function generateVideoAlts(bytes: Buffer, generator: string | null | undefined, extractFrame: VideoFrameExtractor): Promise<ImageAlternates> {
	if (generator != null) {
		return { webpublic: null, thumbnail: null };
	}
	try {
		return { webpublic: null, thumbnail: await generateVideoThumbnail(bytes, extractFrame) };
	} catch {
		return { webpublic: null, thumbnail: null };
	}
}
