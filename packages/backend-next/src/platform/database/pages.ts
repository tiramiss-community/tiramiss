/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull } from 'typeorm';
import { MiPage, MiPageLike, MiUser, MiEmoji, MiDriveFile } from 'backend-upstream/entities';
import { renderDriveFile } from '../../modules/drive/files-public.js';
import { createDriveFileStore } from './drive-files.js';
import { readMeta } from './meta.js';
import { readNoteAuthors } from './note-authors.js';
import type { EntityManager } from 'typeorm';
import type { PageRow, PagePorts } from '../../modules/page/public.js';
import type { DriveFileFacts, DriveFileMediaOptions } from '../../modules/drive/files-public.js';
export function createPageStore(manager: EntityManager, media: DriveFileMediaOptions): Omit<PagePorts, 'writeFailed'> {
	const pages = manager.getRepository(MiPage);
	const files = createDriveFileStore(manager, media);
	const attachmentFacts = (file: MiDriveFile): DriveFileFacts => ({
		id: file.id, userId: file.userId, folderId: file.folderId, name: file.name, type: file.type, md5: file.md5, size: file.size,
		isSensitive: file.isSensitive, blurhash: file.blurhash, properties: structuredClone(file.properties), thumbnailUrl: file.thumbnailUrl,
		comment: file.comment, uri: file.uri, userHost: file.userHost, isLink: file.isLink,
		webpublicAccessKey: file.webpublicAccessKey, webpublicUrl: file.webpublicUrl, url: file.url,
	});
	const row = (page: MiPage): PageRow => ({
		id: page.id, userId: page.userId, updatedAt: page.updatedAt, content: structuredClone(page.content), variables: structuredClone(page.variables),
		title: page.title, name: page.name, summary: page.summary, hideTitleWhenPinned: page.hideTitleWhenPinned,
		alignCenter: page.alignCenter, font: page.font, script: page.script, eyeCatchingImageId: page.eyeCatchingImageId, likedCount: page.likedCount,
	});
	return {
		createdAtFromId: media.createdAtFromId,
		async findPage(query) {
			let page: MiPage | null;
			if ('pageId' in query) {
				// The pinned endpoint selects the ID branch by presence, even if anyOf admitted null through the name branch.
				page = await pages.findOneBy(query.pageId == null ? {} : { id: query.pageId });
			} else {
				const user = await manager.getRepository(MiUser).findOneBy({ host: IsNull(), usernameLower: query.username.toLowerCase() });
				page = user ? await pages.findOneBy({ userId: user.id, name: query.name }) : null;
			}
			return page ? row(page) : null;
		},
		async writeContent(id, content) {
			// TypeORM's deep partial type cannot represent arbitrary JSONB block values.
			await pages.createQueryBuilder().update().set({ content: () => 'CAST(:content AS jsonb)' })
				.where('id = :id', { id }).setParameter('content', JSON.stringify(content)).execute();
		},
		async load(page, attachmentIds, viewerId, now) {
			const meta = await readMeta(manager);
			const owner = await manager.getRepository(MiUser).findOneByOrFail({ id: page.userId });
			const emojis = owner.host && owner.emojis.length ? await manager.getRepository(MiEmoji).findBy({ host: owner.host, name: In(owner.emojis) }) : [];
			const emojiUrls = new Map(emojis.map(e => [`${e.name}@${e.host}`, e.publicUrl || e.originalUrl]));
			const authors = await readNoteAuthors(manager, [owner.id], viewerId, meta, media, now, emojiUrls, false, [owner]);
			const user = authors.get(owner.id)!.view;
			const attachments = (await Promise.all(attachmentIds.map(async id => {
				// Match the pinned nullish-WHERE behavior locally while keeping the owner constraint.
				return manager.getRepository(MiDriveFile).findOneBy({ userId: page.userId, ...(id == null ? {} : { id }) });
			}))).filter(file => file !== null);
			const [eye] = page.eyeCatchingImageId ? await files.find({ id: page.eyeCatchingImageId }) : [];
			if (page.eyeCatchingImageId && !eye) {
				throw Error('Page eye catching image missing.');
			}
			return {
				user,
				attachedFiles: attachments.map(file => renderDriveFile(attachmentFacts(file), meta.proxyRemoteFiles, media, { nullable: true })),
				eyeCatchingImage: eye ? renderDriveFile(eye, meta.proxyRemoteFiles, media) : null,
				...(viewerId ? { isLiked: await manager.getRepository(MiPageLike).existsBy({ pageId: page.id, userId: viewerId }) } : {}),
			};
		},
	};
}
