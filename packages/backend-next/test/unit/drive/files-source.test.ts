/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createAccessRequest, InputInvalid } from '../../../src/modules/access/public.js';
import { createDriveFiles, DriveFileError } from '../../../src/modules/drive/files.js';
import { renderDriveFile, validateFileName } from '../../../src/modules/drive/file-view.js';
import { renderDriveFolder } from '../../../src/modules/drive/folders.js';
import { createIdCodec } from '../../../src/platform/id-codec.js';
import type { DriveStoredFile, DriveFileQuery } from '../../../src/modules/drive/files.js';
import type { DriveFilePacking } from '../../../src/modules/drive/file-view.js';
import type { DriveFolderRow } from '../../../src/modules/drive/folders.js';
const directory = new URL('../../../../../docs/superpowers/compatibility/drive-files/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	rows: DriveStoredFile[]; folders: DriveFolderRow[]; cases: { id: string; operation: keyof ReturnType<typeof createDriveFiles>; input: unknown; actor: string; fail?: boolean }[];
	packing: { id: string; patch: Partial<DriveStoredFile>; options: DriveFilePacking; external?: boolean; proxy?: boolean; video?: string }[];
	names: string[];
};
const source = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	cases: { id: string; expected: unknown }[]; packing: { id: string; expected: unknown }[]; names: { name: string; expected: boolean }[];
};
const media = { url: 'https://local', mediaProxy: 'https://local/proxy', videoThumbnailGenerator: 'https://video', createdAtFromId: createIdCodec('aidx').createdAtFromId };

function materials() {
	const details = new Map(corpus.folders.map(row => [row.id, { row, counts: { foldersCount: corpus.folders.filter(f => f.parentId === row.id).length, filesCount: corpus.rows.filter(f => f.folderId === row.id).length } }]));
	return { proxyRemoteFiles: false, folders: new Map(corpus.folders.map(row => [row.id, renderDriveFolder(row, media.createdAtFromId, details)])), users: new Map(['alice', 'bob', 'mod'].map(id => [id, { id, username: id }])) };
}

function matches(file: DriveStoredFile, q: DriveFileQuery) {
	if ('url' in q) {
		return [file.url, file.webpublicUrl, file.thumbnailUrl].includes(q.url);
	}
	return Object.entries(q).every(([key, value]) => file[key as keyof DriveStoredFile] === value);
}

for (const c of corpus.cases) {
	test(`pinned-source endpoint ${c.id}`, async () => {
		const app = createDriveFiles({ media, async readActor(id) {
			return { isSuspended: false, isModerator: id === 'mod', isAdministrator: false }; 
		},
																																	async find(q) {
																																		if (c.fail) {
																																			throw Error('database unavailable');
																																		} return corpus.rows.filter(f => matches(f, q)); 
																																	},
																																	async exists(q) {
																																		return corpus.rows.some(f => matches(f, q)); 
																																	}, async preload() {
																																		return materials(); 
																																	} });
		// The source oracle invokes endpoint handlers after the common API gate; that gate is tested by real HTTP.
		const access = createAccessRequest({ requireCredential: true }, { userId: c.actor, native: true });
		let result: unknown; let error: unknown;
		try {
			result = await app[c.operation](access, structuredClone(c.input), 0); 
		} catch (e) {
			error = e instanceof InputInvalid ? { code: 'INVALID_PARAM' } : e instanceof DriveFileError ? { code: e.code, id: e.id } : { message: (e as Error).message }; 
		}
		expect(JSON.parse(JSON.stringify({ ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) }))).toEqual(source.cases.find(s => s.id === c.id)!.expected);
	});
}
for (const c of corpus.packing) {
	test(`pinned-source pack ${c.id}`, () => {
		expect(JSON.parse(JSON.stringify(renderDriveFile({ ...structuredClone(corpus.rows[0]), ...c.patch }, c.proxy ?? false, { ...media, externalMediaProxyEnabled: c.external ?? false, ...(c.video === undefined ? {} : { videoThumbnailGenerator: c.video }) }, c.options, materials())))).toEqual(source.packing.find(s => s.id === c.id)!.expected);
	});
}
for (const c of source.names) {
	test(`pinned-source filename ${JSON.stringify(c.name)}`, () => expect(validateFileName(c.name)).toBe(c.expected));
}
