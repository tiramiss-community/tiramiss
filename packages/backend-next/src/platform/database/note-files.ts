/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MiDriveFile } from 'backend-upstream/entities';
import type { JsonObject } from '../../modules/note/public.js';

export interface NoteMediaOptions {
	url: string;
	mediaProxy?: string;
	externalMediaProxyEnabled?: boolean;
	videoThumbnailGenerator?: string;
	createdAtFromId(id: string): number;
}

function query(params: Record<string, string>): string {
	return Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

/** 本家 DriveFileEntityService.getPublicUrl（mode なし）。 */
export function publicFileUrl(file: MiDriveFile, proxyRemoteFiles: boolean, options: Pick<NoteMediaOptions, 'url' | 'mediaProxy' | 'externalMediaProxyEnabled'>): string {
	if (file.uri !== null && file.userHost !== null && options.externalMediaProxyEnabled) {
		return `${options.mediaProxy}/image.webp?${query({ url: file.uri })}`;
	}
	if (file.uri !== null && file.isLink && proxyRemoteFiles && file.webpublicAccessKey && !file.webpublicAccessKey.includes('/')) {
		return `${options.url}/files/${file.webpublicAccessKey}`;
	}
	return file.webpublicUrl ?? file.url;
}

export function noteFileView(file: MiDriveFile, proxyRemoteFiles: boolean, options: NoteMediaOptions): JsonObject {
	const proxied = (url: string) => `${options.mediaProxy ?? `${options.url}/proxy`}/static.webp?${query({ url, static: '1' })}`;
	const isExternal = file.uri !== null && file.userHost !== null && options.externalMediaProxyEnabled;
	const isExpired = file.uri !== null && file.isLink && proxyRemoteFiles;
	const publicUrl = publicFileUrl(file, proxyRemoteFiles, options);
	const properties = { ...file.properties };
	if (properties.orientation != null) {
		if (properties.orientation >= 5) {
			[properties.width, properties.height] = [properties.height, properties.width];
		}
		delete properties.orientation;
	}
	const baseUrl = file.webpublicUrl ?? file.url;
	const thumbnailUrl = file.type.startsWith('video') ? file.thumbnailUrl ?? (options.videoThumbnailGenerator
		? `${options.videoThumbnailGenerator}/thumbnail.webp?${query({ thumbnail: '1', url: baseUrl })}` : null)
		: (isExternal || isExpired) ? proxied(file.uri!)
			: file.thumbnailUrl ?? (/^image\/(jpeg|png|webp|gif|avif|tiff|apng|vnd\.mozilla\.apng|svg\+xml)$/.test(file.type) ? baseUrl : null);
	return { id: file.id, createdAt: new Date(options.createdAtFromId(file.id)).toISOString(), name: file.name,
		type: file.type, md5: file.md5, size: file.size, isSensitive: file.isSensitive, blurhash: file.blurhash,
		properties, url: publicUrl, thumbnailUrl, comment: file.comment, folderId: file.folderId, folder: null, userId: file.userId, user: null };
}
