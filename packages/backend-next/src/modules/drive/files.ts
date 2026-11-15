/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { renderDriveFile } from './file-view.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { DriveFileFacts, DriveFileMaterials, DriveFileMediaOptions, DriveFilePacking } from './file-view.js';
export interface DriveStoredFile extends DriveFileFacts {
	maybePorn: boolean; maybeSensitive: boolean; src: string | null; thumbnailAccessKey: string | null; accessKey: string | null;
	webpublicType: string | null; storedInternal: boolean; requestIp: string | null; requestHeaders: Record<string, string> | null;
}
export type DriveFileQuery = { id: string } | { url: string } | { name: string; folderId: string | null; userId: string } | { md5: string; userId: string };
export interface DriveFilePorts {
	readActor(id: string, now: number): Promise<AccessFacts>;
	find(query: DriveFileQuery): Promise<DriveStoredFile[]>;
	exists(query: { md5: string; userId: string }): Promise<boolean>;
	preload(files: readonly DriveFileFacts[], packing: DriveFilePacking, now: number): Promise<DriveFileMaterials & { proxyRemoteFiles: boolean }>;
	media: DriveFileMediaOptions;
}
export class DriveFileError extends Error {
	constructor(public readonly code: string, public readonly id: string, message: string) {
		super(message); 
	}
}
const showInput = compileInput<{ fileId?: string; url?: string }>({ anyOf: [
	{ type: 'object', properties: { fileId: { type: 'string', format: 'misskey:id' } }, required: ['fileId'] },
	{ type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
] });
const findInput = compileInput<{ name: string; folderId: string | null }>({ type: 'object', properties: {
	name: { type: 'string' }, folderId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
}, required: ['name'] });
const hashInput = compileInput<{ md5: string }>({ type: 'object', properties: { md5: { type: 'string' } }, required: ['md5'] });
export function createDriveFiles(ports: DriveFilePorts) {
	async function actor(access: AccessRequest, now: number) {
		const credential = requireCredential(access.credential);
		const facts = await ports.readActor(credential.userId, now);
		access.authorize(facts);
		return { id: credential.userId, ...facts };
	}

	async function selected(input: unknown, admin: boolean) {
		const ps = showInput(input);
		const [file] = await ports.find('fileId' in ps ? { id: ps.fileId! } : { url: ps.url! });
		if (!file) {
			throw new DriveFileError('NO_SUCH_FILE', admin ? 'caf3ca38-c6e5-472e-a30c-b05377dcc240' : '067bc436-2718-4795-b0fb-ecbe43949e31', 'No such file.');
		}
		return file;
	}

	async function packed(files: readonly DriveStoredFile[], packing: DriveFilePacking, now: number) {
		const materials = await ports.preload(files, packing, now);
		return files.map(file => renderDriveFile(file, materials.proxyRemoteFiles, ports.media, packing, materials));
	}

	return {
		async show(access: AccessRequest, input: unknown, now: number) {
			const me = await actor(access, now);
			const file = await selected(input, false);
			if (!me.isModerator && file.userId !== me.id) {
				throw new DriveFileError('ACCESS_DENIED', '25b73c73-68b1-41d0-bad1-381cfdf6579f', 'Access denied.');
			}
			return (await packed([file], { self: true, detail: true, withUser: true }, now))[0];
		},
		async find(access: AccessRequest, input: unknown, now: number) {
			const me = await actor(access, now);
			const ps = findInput(input);
			return packed(await ports.find({ name: ps.name, folderId: ps.folderId, userId: me.id }), { self: true, nullable: true }, now);
		},
		async findByHash(access: AccessRequest, input: unknown, now: number) {
			const me = await actor(access, now);
			const ps = hashInput(input);
			return packed(await ports.find({ md5: ps.md5, userId: me.id }), { self: true, nullable: true }, now);
		},
		async checkExistence(access: AccessRequest, input: unknown, now: number) {
			const me = await actor(access, now);
			return ports.exists({ md5: hashInput(input).md5, userId: me.id });
		},
		async adminShow(access: AccessRequest, input: unknown, now: number) {
			const me = await actor(access, now);
			const file = await selected(input, true);
			const ownerIsModerator = file.userId ? (await ports.readActor(file.userId, now)).isModerator : false;
			const { id, userId, userHost, isLink, maybePorn, maybeSensitive, isSensitive, folderId, src, uri, webpublicAccessKey, thumbnailAccessKey, accessKey, webpublicType, webpublicUrl, thumbnailUrl, url, storedInternal, properties, blurhash, comment, size, type, name, md5 } = file;
			return {
				id, userId, userHost, isLink, maybePorn, maybeSensitive, isSensitive, folderId, src, uri,
				webpublicAccessKey, thumbnailAccessKey, accessKey, webpublicType, webpublicUrl, thumbnailUrl, url,
				storedInternal, properties, blurhash, comment, size, type, name, md5,
				createdAt: new Date(ports.media.createdAtFromId(id)).toISOString(),
				requestIp: me.isModerator ? file.requestIp : null,
				requestHeaders: me.isModerator && !ownerIsModerator ? file.requestHeaders : null,
			};
		},
	};
}
