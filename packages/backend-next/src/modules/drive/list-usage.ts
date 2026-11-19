/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { planPagination } from '../shared/pagination.js';
import { renderDriveFile } from './file-view.js';
import { renderDriveFolder } from './folders.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { PaginationInput, PaginationPlan } from '../shared/pagination.js';
import type { DriveFilePorts, DriveStoredFile } from './files.js';
import type { DriveFolderRow } from './folders.js';

export type DriveUsageSelection = { userId: string } | { host: string } | { origin: 'local' | 'remote' };
export interface DriveListInput extends PaginationInput {
	limit: number;
	folderId?: string | null;
	type?: string | null;
	sort?: '+createdAt' | '-createdAt' | '+name' | '-name' | '+size' | '-size' | null;
	userId?: string | null;
	origin?: 'combined' | 'local' | 'remote';
	hostname?: string | null;
}
export interface DriveListPorts {
	readActor(id: string, now: number): Promise<AccessFacts>;
	readCapacityMb(id: string, now: number): Promise<number>;
	readUsage(selection: DriveUsageSelection): Promise<number>;
	listFiles(input: DriveListInput, page: PaginationPlan, userId: string, mode: 'files' | 'stream' | 'admin'): Promise<DriveStoredFile[]>;
	listFolders(input: DriveListInput, page: PaginationPlan, userId: string): Promise<DriveFolderRow[]>;
	preload: DriveFilePorts['preload'];
	media: DriveFilePorts['media'];
	idFromDate(date: number): string;
}
const pageProperties = {
	limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
	sinceId: { type: 'string', format: 'misskey:id' }, untilId: { type: 'string', format: 'misskey:id' },
	sinceDate: { type: 'integer' }, untilDate: { type: 'integer' },
};
const folderId = { type: 'string', format: 'misskey:id', nullable: true, default: null };
const mime = { type: 'string', pattern: '^[a-zA-Z/\\-*]+$' };
const emptyInput = compileInput<object>({ type: 'object', properties: {}, required: [] });
const filesInput = compileInput<DriveListInput>({ type: 'object', properties: {
	...pageProperties, folderId, type: { ...mime, nullable: true },
	sort: { type: 'string', nullable: true, enum: ['+createdAt', '-createdAt', '+name', '-name', '+size', '-size', null] },
}, required: [] });
const streamInput = compileInput<DriveListInput>({ type: 'object', properties: { ...pageProperties, type: mime }, required: [] });
const foldersInput = compileInput<DriveListInput>({ type: 'object', properties: { ...pageProperties, folderId }, required: [] });
const adminInput = compileInput<DriveListInput>({ type: 'object', properties: {
	...pageProperties, userId: { type: 'string', format: 'misskey:id', nullable: true },
	type: { type: 'string', nullable: true, pattern: '^[a-zA-Z0-9/\\-*]+$' },
	origin: { type: 'string', enum: ['combined', 'local', 'remote'], default: 'local' },
	hostname: { type: 'string', nullable: true, default: null },
}, required: [] });

export function createDriveListUsage(ports: DriveListPorts) {
	async function actor(access: AccessRequest, now: number) {
		const credential = requireCredential(access.credential);
		return access.authorize(await ports.readActor(credential.userId, now)).userId;
	}

	async function list(access: AccessRequest, input: unknown, now: number, mode: 'files' | 'stream' | 'admin') {
		const userId = await actor(access, now);
		const ps = (mode === 'files' ? filesInput : mode === 'stream' ? streamInput : adminInput)(input);
		const files = await ports.listFiles(ps, planPagination(ps, ports.idFromDate), userId, mode);
		const packing = { self: true, nullable: true, ...(mode === 'admin' ? { detail: true, withUser: true } : {}) };
		const materials = await ports.preload(files, packing, now);
		return files.map(file => renderDriveFile(file, materials.proxyRemoteFiles, ports.media, packing, materials));
	}

	return {
		async usage(access: AccessRequest, input: unknown, now: number) {
			const userId = await actor(access, now);
			emptyInput(input);
			const usage = await ports.readUsage({ userId });
			const capacityMb = await ports.readCapacityMb(userId, now);
			return { capacity: 1024 * 1024 * capacityMb, usage };
		},
		files: (access: AccessRequest, input: unknown, now: number) => list(access, input, now, 'files'),
		stream: (access: AccessRequest, input: unknown, now: number) => list(access, input, now, 'stream'),
		adminFiles: (access: AccessRequest, input: unknown, now: number) => list(access, input, now, 'admin'),
		async folders(access: AccessRequest, input: unknown, now: number) {
			const userId = await actor(access, now);
			const ps = foldersInput(input);
			return (await ports.listFolders(ps, planPagination(ps, ports.idFromDate), userId)).map(row => renderDriveFolder(row, ports.media.createdAtFromId));
		},
	};
}
