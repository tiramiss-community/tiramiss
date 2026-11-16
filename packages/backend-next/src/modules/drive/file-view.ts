/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { getExternalVideoThumbnailUrl } from './video-thumbnail-url.js';
import { publicFileUrl } from './public-file-url.js';
import type { PublicFileFacts } from './public-file-url.js';
import type { DriveFolderView } from './folders.js';
export interface DriveFileFacts extends PublicFileFacts {
	id: string; userId: string | null; folderId: string | null; name: string; type: string; md5: string; size: number;
	isSensitive: boolean; blurhash: string | null; properties: { width?: number; height?: number; orientation?: number; avgColor?: string };
	thumbnailUrl: string | null; comment: string | null;
}
export interface DriveFileMediaOptions {
	url: string; mediaProxy?: string; externalMediaProxyEnabled?: boolean; videoThumbnailGenerator?: string;
	createdAtFromId(id: string): number;
}
export interface DriveFilePacking { self?: boolean; detail?: boolean; withUser?: boolean; nullable?: boolean }
export interface DriveFileMaterials { folders?: ReadonlyMap<string, DriveFolderView>; users?: ReadonlyMap<string, Record<string, unknown>> }

function required<T>(map: ReadonlyMap<string, T> | undefined, id: string, label: string): T {
	const value = map?.get(id);
	if (!value) {
		throw Error(`${label} detail missing: ${id}`);
	}
	return value;
}

export function validateFileName(name: string): boolean {
	return name.trim().length > 0 && name.length <= 200 && !name.includes('\\') && !name.includes('/') && !name.includes('..');
}

function query(params: Record<string, string>): string {
	return Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

export function renderDriveFile(file: DriveFileFacts, proxyRemoteFiles: boolean, options: DriveFileMediaOptions, packing: DriveFilePacking = {}, materials: DriveFileMaterials = {}): Record<string, unknown> {
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
	const thumbnailUrl = file.type.startsWith('video') ? file.thumbnailUrl || getExternalVideoThumbnailUrl(baseUrl, options.videoThumbnailGenerator)
		: (isExternal || isExpired) ? proxied(file.uri!)
		: file.thumbnailUrl ?? (/^image\/(jpeg|png|webp|gif|avif|tiff|apng|vnd\.mozilla\.apng|svg\+xml)$/.test(file.type) ? baseUrl : null);
	return {
		id: file.id, createdAt: new Date(options.createdAtFromId(file.id)).toISOString(), name: file.name,
		type: file.type, md5: file.md5, size: file.size, isSensitive: file.isSensitive, blurhash: file.blurhash,
		properties: packing.self ? file.properties : properties, url: packing.self ? file.url : publicUrl,
		thumbnailUrl, comment: file.comment, folderId: file.folderId,
		folder: packing.detail && file.folderId ? required(materials.folders, file.folderId, 'Folder') : null,
		userId: packing.withUser || packing.nullable ? file.userId : null,
		user: packing.withUser && file.userId ? required(materials.users, file.userId, 'User') : null,
	};
}
