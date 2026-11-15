/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { renderDriveFile } from '../../modules/drive/files-public.js';
import type { MiDriveFile } from 'backend-upstream/entities';
import type { DriveFileMediaOptions } from '../../modules/drive/files-public.js';
export { publicFileUrl } from '../../modules/drive/public.js';
export type NoteMediaOptions = DriveFileMediaOptions;
export function noteFileView(file: MiDriveFile, proxyRemoteFiles: boolean, options: NoteMediaOptions): Record<string, unknown> {
	return renderDriveFile(file, proxyRemoteFiles, options, { nullable: true });
}
