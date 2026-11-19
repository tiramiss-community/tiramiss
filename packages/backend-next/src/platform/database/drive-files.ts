/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull } from 'typeorm';
import { MiDriveFile, MiUser, MiEmoji } from 'backend-upstream/entities';
import { renderDriveFolder } from '../../modules/drive/folders.js';
import { createDriveFolderStore } from './drive-folders.js';
import { readNoteAuthors } from './note-authors.js';
import { readMeta } from './meta.js';
import type { EntityManager } from 'typeorm';
import type { DriveFolderRow, DriveFolderCounts, DriveFolderView } from '../../modules/drive/folders.js';
import type { DriveFilePorts, DriveStoredFile } from '../../modules/drive/files.js';
import type { DriveFileMediaOptions } from '../../modules/drive/files-public.js';

// Explicitly project persisted columns: entities never cross the adapter boundary.
export const driveStoredFile = (file: MiDriveFile): DriveStoredFile => ({
	id: file.id, userId: file.userId, userHost: file.userHost, folderId: file.folderId, name: file.name, type: file.type, md5: file.md5, size: file.size,
	isSensitive: file.isSensitive, blurhash: file.blurhash, properties: structuredClone(file.properties), url: file.url, webpublicUrl: file.webpublicUrl,
	uri: file.uri, isLink: file.isLink, webpublicAccessKey: file.webpublicAccessKey, thumbnailUrl: file.thumbnailUrl, comment: file.comment,
	maybePorn: file.maybePorn, maybeSensitive: file.maybeSensitive, src: file.src, thumbnailAccessKey: file.thumbnailAccessKey, accessKey: file.accessKey,
	webpublicType: file.webpublicType, storedInternal: file.storedInternal, requestIp: file.requestIp, requestHeaders: file.requestHeaders,
});

export function createDriveFileStore(manager: EntityManager, media: DriveFileMediaOptions): DriveFilePorts {
	const files = manager.getRepository(MiDriveFile);
	const folders = createDriveFolderStore(manager, media.createdAtFromId);

	return {
		media, readActor: folders.readActor,
		async find(query) {
			if ('id' in query) {
				const file = await files.findOneBy({ id: query.id });
				return file ? [driveStoredFile(file)] : [];
			}
			if ('url' in query) {
				const file = await files.findOneBy([{ url: query.url }, { webpublicUrl: query.url }, { thumbnailUrl: query.url }]);
				return file ? [driveStoredFile(file)] : [];
			}
			return (await files.findBy('name' in query ? { ...query, folderId: query.folderId ?? IsNull() } : query)).map(driveStoredFile);
		},
		exists: query => files.existsBy(query),
		async preload(rows, packing, now) {
			const meta = await readMeta(manager);
			const details = new Map<string, { row: DriveFolderRow; counts: DriveFolderCounts }>();
			const folderViews = new Map<string, DriveFolderView>();
			if (packing.detail) {
				for (const id of new Set(rows.flatMap(file => file.folderId ? [file.folderId] : []))) {
					let current: string | null = id;
					const path = new Set<string>();
					while (current && !details.has(current)) {
						path.add(current);
						const folder = await folders.readFolder(current);
						if (!folder) {
							throw Error('folder missing');
						}
						details.set(current, { row: folder, counts: await folders.readCounts(current) });
						current = folder.parentId;
					}
					// Concurrent moves can make separately read rows cyclic; stop before recursive projection.
					if (current && path.has(current)) {
						throw Error('Drive folder hierarchy contains a cycle.');
					}
					folderViews.set(id, renderDriveFolder(details.get(id)!.row, media.createdAtFromId, details));
				}
			}
			const users = new Map<string, Record<string, unknown>>();
			if (packing.withUser) {
				const ids = [...new Set(rows.flatMap(file => file.userId ? [file.userId] : []))];
				if (ids.length) {
					const owners = await manager.getRepository(MiUser).findBy({ id: In(ids) });
					if (owners.length !== ids.length) {
						throw Error('user missing');
					}
					const hosts = [...new Set(owners.flatMap(u => u.host ? [u.host] : []))];
					const names = [...new Set(owners.flatMap(u => u.emojis))];
					const emojiUrls = new Map((hosts.length && names.length ? await manager.getRepository(MiEmoji).findBy({ host: In(hosts), name: In(names) }) : []).map(e => [`${e.name}@${e.host}`, e.publicUrl || e.originalUrl]));
					const authors = await readNoteAuthors(manager, ids, null, meta, media, now, emojiUrls);
					for (const [id, author] of authors) {
						users.set(id, author.view);
					}
				}
			}
			return { proxyRemoteFiles: meta.proxyRemoteFiles, folders: folderViews, users };
		},
	};
}
