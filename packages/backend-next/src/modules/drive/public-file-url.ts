/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface PublicFileFacts {
	uri: string | null;
	userHost: string | null;
	isLink: boolean;
	webpublicAccessKey: string | null;
	webpublicUrl: string | null;
	url: string;
}
export interface PublicFileUrlOptions {
	url: string;
	mediaProxy?: string;
	externalMediaProxyEnabled?: boolean;
}

/** 本家 DriveFileEntityService.getPublicUrl（mode なし）。 */
export function publicFileUrl(file: PublicFileFacts, proxyRemoteFiles: boolean, options: PublicFileUrlOptions): string {
	if (file.uri !== null && file.userHost !== null && options.externalMediaProxyEnabled) {
		return `${options.mediaProxy}/image.webp?url=${encodeURIComponent(file.uri)}`;
	}
	if (file.uri !== null && file.isLink && proxyRemoteFiles && file.webpublicAccessKey && !file.webpublicAccessKey.includes('/')) {
		return `${options.url}/files/${file.webpublicAccessKey}`;
	}
	return file.webpublicUrl ?? file.url;
}
