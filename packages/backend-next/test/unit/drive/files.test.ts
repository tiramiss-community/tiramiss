/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { renderDriveFile, validateFileName } from '../../../src/modules/drive/file-view.js';
const file = { id: 'file', userId: 'owner', folderId: 'folder', name: 'test.png', type: 'image/png', md5: 'hash', size: 1, isSensitive: false, blurhash: null, properties: { width: 10, height: 20, orientation: 6 }, url: 'https://local/original', webpublicUrl: 'https://local/public', uri: null, userHost: null, isLink: false, webpublicAccessKey: null, thumbnailUrl: null, comment: null };
const options = { url: 'https://local', createdAtFromId: () => 0 };
test('self keeps raw properties and original URL; public rotates without mutating facts', () => {
	expect(renderDriveFile(file, false, options, { self: true })).toMatchObject({ url: file.url, properties: file.properties, userId: null, user: null, folder: null });
	const view = renderDriveFile(file, false, options);
	expect(view).toMatchObject({ url: file.webpublicUrl, properties: { width: 20, height: 10 }, userId: null });
	expect(view.properties).not.toHaveProperty('orientation');
	expect(file.properties.orientation).toBe(6);
});
test('nullable/many packing keeps userId; requested details require preloaded materials', () => {
	const folder = { id: 'folder', createdAt: '1970-01-01T00:00:00.000Z', name: 'f', parentId: null, foldersCount: 0, filesCount: 1 };
	const user = { id: 'owner', username: 'owner' };
	expect(renderDriveFile(file, false, options, { nullable: true })).toHaveProperty('userId', 'owner');
	expect(renderDriveFile(file, false, options, { detail: true, withUser: true }, { folders: new Map([['folder', folder]]), users: new Map([['owner', user]]) })).toMatchObject({ folder, user, userId: 'owner' });
	expect(() => renderDriveFile(file, false, options, { detail: true })).toThrow('Folder detail missing');
	expect(() => renderDriveFile(file, false, options, { withUser: true })).toThrow('User detail missing');
});
test.each(['a', ' a ', '.png', 'あ'.repeat(200)])('valid file name %s', name => expect(validateFileName(name)).toBe(true));
test.each(['', ' \n ', 'a/b', 'a\\b', '..', 'a..b', 'a'.repeat(201), '😀'.repeat(101)])('invalid file name %s', name => expect(validateFileName(name)).toBe(false));
