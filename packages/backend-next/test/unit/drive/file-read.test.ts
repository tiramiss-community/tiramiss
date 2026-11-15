/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import { createDriveFiles } from '../../../src/modules/drive/files.js';
import type { DriveFilePorts, DriveStoredFile } from '../../../src/modules/drive/files.js';
const row = { id: 'file', userId: 'owner', userHost: null, folderId: null, name: 'file', type: 'image/png', md5: 'hash', size: 1, isSensitive: false, blurhash: null, properties: { orientation: 6 }, url: 'original', webpublicUrl: 'public', uri: null, isLink: false, webpublicAccessKey: null, thumbnailUrl: null, comment: null, maybePorn: false, maybeSensitive: false, src: null, thumbnailAccessKey: null, accessKey: null, webpublicType: null, storedInternal: true, requestIp: 'ip', requestHeaders: { secret: 'header' } } satisfies DriveStoredFile;
const access = (userId = 'owner', admin = false) => createAccessRequest({ requireCredential: true, kind: admin ? 'read:admin:drive' : 'read:drive', requireModerator: admin }, { userId, native: true });

function setup(patch: Partial<DriveFilePorts> = {}) {
	const queries: unknown[] = [];
	const ports: DriveFilePorts = {
		async readActor(id) {
			return { isSuspended: false, isModerator: id === 'mod', isAdministrator: false }; 
		},
		async find(query) {
			queries.push(query); return [row]; 
		},
		async exists(query) {
			queries.push(query); return true; 
		},
		async preload() {
			return { proxyRemoteFiles: false, users: new Map([['owner', { id: 'owner' }]]) }; 
		},
		media: { url: 'https://local', createdAtFromId: () => 0 }, ...patch,
	};
	return { app: createDriveFiles(ports), queries, ports };
}

test('ID precedence, owner/moderator show and cross-owner denial', async () => {
	const { app, queries } = setup();
	expect(await app.show(access(), { fileId: 'file', url: 'public' }, 0)).toMatchObject({ url: 'original', properties: { orientation: 6 } });
	expect(queries).toEqual([{ id: 'file' }]);
	await expect(app.show(access('other'), { fileId: 'file' }, 0)).rejects.toMatchObject({ code: 'ACCESS_DENIED', id: '25b73c73-68b1-41d0-bad1-381cfdf6579f' });
	expect(await app.show(access('mod'), { url: 'public' }, 0)).toHaveProperty('id', 'file');
});
test('find/hash/existence restrict every actor including moderators', async () => {
	const { app, queries } = setup();
	expect(await app.find(access('mod'), { name: '' }, 0)).toHaveLength(1);
	await app.findByHash(access(), { md5: '' }, 0);
	expect(await app.checkExistence(access(), { md5: 'hash' }, 0)).toBe(true);
	expect(queries).toEqual([{ name: '', folderId: null, userId: 'mod' }, { md5: '', userId: 'owner' }, { md5: 'hash', userId: 'owner' }]);
});
test('missing rows use distinct endpoint IDs; query and preload DB errors propagate', async () => {
	const { app } = setup({ find: async () => [] });
	await expect(app.show(access(), { fileId: 'file' }, 0)).rejects.toMatchObject({ code: 'NO_SUCH_FILE', id: '067bc436-2718-4795-b0fb-ecbe43949e31' });
	await expect(app.adminShow(access('mod', true), { fileId: 'file' }, 0)).rejects.toMatchObject({ id: 'caf3ca38-c6e5-472e-a30c-b05377dcc240' });
	const failure = Error('database unavailable');
	await expect(setup({ find: async () => {
		throw failure; 
	} }).app.show(access(), { fileId: 'file' }, 0)).rejects.toBe(failure);
	await expect(setup({ preload: async () => {
		throw failure; 
	} }).app.find(access(), { name: 'file' }, 0)).rejects.toBe(failure);
});
test('admin exposes stored fields, redacting moderator owner request headers', async () => {
	const { app } = setup();
	expect(await app.adminShow(access('mod', true), { url: 'public' }, 0)).toMatchObject({ requestIp: 'ip', requestHeaders: { secret: 'header' }, url: 'original', properties: { orientation: 6 } });
	const own = setup({ find: async () => [{ ...row, userId: 'mod' }] });
	expect(await own.app.adminShow(access('mod', true), { fileId: 'file' }, 0)).toHaveProperty('requestHeaders', null);
});
test('authorization runs before input/query; malformed union ID keeps upstream ID precedence', async () => {
	const find = vi.fn(async () => [row]);
	const { app } = setup({ find });
	const denied = createAccessRequest({ requireCredential: true, kind: 'read:drive' }, { userId: 'owner', native: false, permissions: new Set() });
	await expect(app.show(denied, {}, 0)).rejects.toHaveProperty('reason', 'PERMISSION_DENIED');
	expect(find).not.toHaveBeenCalled();
	await app.show(access(), { fileId: 123, url: 'public' }, 0);
	expect(find).toHaveBeenCalledWith({ id: 123 });
});
