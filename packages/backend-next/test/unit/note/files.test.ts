/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { noteFileView } from '../../../src/platform/database/note-files.js';
import type { MiDriveFile } from 'backend-upstream/entities';

const options = { url: 'https://local.test', createdAtFromId: () => 1000 };
const file = (patch: Partial<MiDriveFile> = {}) => ({ id: 'file', uri: null, userHost: null, userId: 'owner', name: 'test', type: 'image/png', md5: '0'.repeat(32), size: 1,
	isSensitive: false, blurhash: null, properties: {}, url: 'https://file.test/a.png', webpublicUrl: null,
	thumbnailUrl: null, comment: null, folderId: null, isLink: false, webpublicAccessKey: null, ...patch } as MiDriveFile);

test('public properties swap rotated dimensions without mutating persisted facts', () => {
	const input = file({ properties: { width: 100, height: 200, orientation: 6 } });
	expect(noteFileView(input, false, options)).toMatchObject({ properties: { width: 200, height: 100 }, userId: 'owner', folder: null, user: null });
	expect(input.properties).toEqual({ width: 100, height: 200, orientation: 6 });
});

test.each(['image/png', 'image/apng', 'image/vnd.mozilla.apng', 'image/svg+xml'])('%s has fallback image thumbnail', type => {
	expect(noteFileView(file({ type }), false, options).thumbnailUrl).toBe('https://file.test/a.png');
});

test.each(['image/heic', 'image/heif', 'application/pdf'])('%s does not invent an image thumbnail', type => {
	expect(noteFileView(file({ type }), false, options).thumbnailUrl).toBeNull();
});

test('external media proxy and expired link preserve upstream URL branches', () => {
	const input = file({ uri: 'https://remote.test/media?q=1', userHost: 'remote.test', isLink: true, webpublicAccessKey: 'key' });
	const external = noteFileView(input, true, { ...options, mediaProxy: 'https://proxy.test', externalMediaProxyEnabled: true });
	expect(external.url).toBe('https://proxy.test/image.webp?url=https%3A%2F%2Fremote.test%2Fmedia%3Fq%3D1');
	expect(external.thumbnailUrl).toBe('https://proxy.test/static.webp?url=https%3A%2F%2Fremote.test%2Fmedia%3Fq%3D1&static=1');
	expect(noteFileView(input, true, options).url).toBe('https://local.test/files/key');
	expect(noteFileView(file({ ...input, webpublicAccessKey: 'old/key' }), true, options).url).toBe(input.url);
});

test('video honors persisted thumbnail and configured generator; PDF keeps null', () => {
	const input = file({ type: 'video/mp4' });
	expect(noteFileView(input, false, options).thumbnailUrl).toBeNull();
	expect(noteFileView(input, false, { ...options, videoThumbnailGenerator: 'https://video.test' }).thumbnailUrl).toBe('https://video.test/thumbnail.webp?thumbnail=1&url=https%3A%2F%2Ffile.test%2Fa.png');
	expect(noteFileView(file({ ...input, thumbnailUrl: 'https://file.test/thumb' }), false, options).thumbnailUrl).toBe('https://file.test/thumb');
});

test('proxy query encoding preserves upstream percent-encoded spaces', () => {
	const input = file({ uri: 'https://remote.test/a b.png', userHost: 'remote.test' });
	expect(noteFileView(input, false, { ...options, mediaProxy: 'https://proxy.test', externalMediaProxyEnabled: true }).url).toBe('https://proxy.test/image.webp?url=https%3A%2F%2Fremote.test%2Fa%20b.png');
});
