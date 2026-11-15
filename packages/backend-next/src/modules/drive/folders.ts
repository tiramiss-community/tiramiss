/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
export interface DriveFolderRow {
	id: string;
	userId: string | null;
	name: string;
	parentId: string | null;
}
export interface DriveFolderCounts {
	foldersCount: number;
	filesCount: number;
}
export interface DriveFolderView {
	id: string;
	createdAt: string;
	name: string;
	parentId: string | null;
	foldersCount?: number;
	filesCount?: number;
	parent?: DriveFolderView;
}
export type DriveFolderEvent = 'folderCreated' | 'folderUpdated' | 'folderDeleted';
export interface DriveFolderPorts {
	readActor(id: string, now: number): Promise<AccessFacts & {
		rateLimitFactor: number;
	}>;
	limit(id: string, factor: number): Promise<void>;
	readFolder(id: string, userId?: string): Promise<DriveFolderRow | null>;
	findFolders(name: string, parentId: string | null, userId: string): Promise<DriveFolderRow[]>;
	readCounts(id: string): Promise<DriveFolderCounts>;
	insertFolder(row: DriveFolderRow): Promise<void>;
	updateFolder(row: DriveFolderRow): Promise<void>;
	deleteFolder(id: string): Promise<void>;
	publish(userId: string, type: DriveFolderEvent, body: DriveFolderView | string): void;
	newId(): string;
	createdAtFromId(id: string): number;
}
const missingIds = { create: '53326628-a00d-40a6-a3cd-8975105c0f95', delete: '1069098f-c281-440f-b085-f9932edbe091', show: 'd74ab9eb-bb09-4bba-bf24-fb58f761e1e9', update: 'f7974dac-2c0d-4a27-926e-23583b28e98e' };
export class DriveFolderError extends Error {
	constructor(public readonly code: string, public readonly id: string, message: string, public readonly info?: object) {
		super(message);
	}
}

function missing(operation: keyof typeof missingIds): never {
	throw new DriveFolderError('NO_SUCH_FOLDER', missingIds[operation], 'No such folder.');
}

function recursive(): never {
	throw new DriveFolderError('RECURSIVE_NESTING', 'dbeb024837894013aed44279f9199740', 'It can not be structured like nesting folders recursively.');
}

const folderId = { type: 'string', format: 'misskey:id' };
const parentId = { ...folderId, nullable: true };
const createInput = compileInput<{
	name: string;
	parentId?: string | null;
}>({ type: 'object', properties: { name: { type: 'string', default: 'Untitled', maxLength: 200 }, parentId }, required: [] });
const findInput = compileInput<{
	name: string;
	parentId: string | null;
}>({ type: 'object', properties: { name: { type: 'string' }, parentId: { ...parentId, default: null } }, required: ['name'] });
const showInput = compileInput<{
	folderId: string;
}>({ type: 'object', properties: { folderId }, required: ['folderId'] });
const updateInput = compileInput<{
	folderId: string;
	name?: string;
	parentId?: string | null;
}>({ type: 'object', properties: { folderId, name: { type: 'string', maxLength: 200 }, parentId }, required: ['folderId'] });
/** All hierarchy/count materials are already present; projection performs no I/O. */
export function renderDriveFolder(row: DriveFolderRow, createdAtFromId: (id: string) => number, details?: ReadonlyMap<string, {
	row: DriveFolderRow;
	counts: DriveFolderCounts;
}>): DriveFolderView {
	const basic = { id: row.id, createdAt: new Date(createdAtFromId(row.id)).toISOString(), name: row.name, parentId: row.parentId };
	if (!details) {
		return basic;
	}
	const material = details.get(row.id);
	if (!material) {
		throw Error(`Folder detail missing: ${row.id}`);
	}
	return { ...basic, ...material.counts, ...(row.parentId ? { parent: renderDriveFolder(details.get(row.parentId)!.row, createdAtFromId, details) } : {}) };
}
export function createDriveFolders(ports: DriveFolderPorts) {
	const basic = (row: DriveFolderRow) => renderDriveFolder(row, ports.createdAtFromId);

	async function actor(access: AccessRequest, now: number, limited = false) {
		const credential = requireCredential(access.credential);
		const facts = await ports.readActor(credential.userId, now);
		// ApiCallService consumes the authenticated actor's window before suspension, scope and input validation.
		if (limited && facts.rateLimitFactor > 0) {
			await ports.limit(credential.userId, facts.rateLimitFactor);
		}
		return access.authorize(facts).userId;
	}

	return {
		async create(access: AccessRequest, input: unknown, now: number): Promise<DriveFolderView> {
			const userId = await actor(access, now, true);
			const ps = createInput(input);
			const parent = ps.parentId ? await ports.readFolder(ps.parentId, userId) : null;
			if (ps.parentId && !parent) {
				missing('create');
			}
			const row = { id: ports.newId(), userId, name: ps.name, parentId: parent?.id ?? null };
			await ports.insertFolder(row);
			const view = basic(row);
			ports.publish(userId, 'folderCreated', view);
			return view;
		},
		async find(access: AccessRequest, input: unknown, now: number): Promise<DriveFolderView[]> {
			const userId = await actor(access, now);
			const ps = findInput(input);
			return (await ports.findFolders(ps.name, ps.parentId, userId)).map(basic);
		},
		async show(access: AccessRequest, input: unknown, now: number): Promise<DriveFolderView> {
			const userId = await actor(access, now);
			const ps = showInput(input);
			const row = await ports.readFolder(ps.folderId, userId);
			if (!row) {
				missing('show');
			}
			const details = new Map<string, {
				row: DriveFolderRow;
				counts: DriveFolderCounts;
			}>();
			let current: DriveFolderRow | null = row;
			while (current) {
				details.set(current.id, { row: current, counts: await ports.readCounts(current.id) });
				if (current.parentId) {
					current = await ports.readFolder(current.parentId);
					if (!current) {
						throw Error('folder missing');
					}
				} else {
					current = null;
				}
			}
			return renderDriveFolder(row, ports.createdAtFromId, details);
		},
		async update(access: AccessRequest, input: unknown, now: number): Promise<DriveFolderView> {
			const userId = await actor(access, now);
			const ps = updateInput(input);
			const row = await ports.readFolder(ps.folderId, userId);
			if (!row) {
				missing('update');
			}
			if (ps.name) {
				row.name = ps.name;
			}
			if (ps.parentId !== undefined) {
				if (ps.parentId === row.id) {
					recursive();
				}
				if (ps.parentId === null) {
					row.parentId = null;
				} else {
					const parent = await ports.readFolder(ps.parentId, userId);
					if (!parent) {
						throw new DriveFolderError('NO_SUCH_PARENT_FOLDER', 'ce104e3a-faaf-49d5-b459-10ff0cbbcaa1', 'No such parent folder.');
					}
					let id = parent.parentId;
					while (id) {
						const ancestor = await ports.readFolder(id);
						if (!ancestor) {
							throw Error('folder missing');
						}
						if (ancestor.id === row.id) {
							recursive();
						}
						id = ancestor.parentId;
					}
					row.parentId = parent.id;
				}
			}
			await ports.updateFolder(row);
			const view = basic(row);
			ports.publish(userId, 'folderUpdated', view);
			return view;
		},
		async delete(access: AccessRequest, input: unknown, now: number): Promise<void> {
			const userId = await actor(access, now);
			const ps = showInput(input);
			const row = await ports.readFolder(ps.folderId, userId);
			if (!row) {
				missing('delete');
			}
			const counts = await ports.readCounts(row.id);
			if (counts.foldersCount !== 0 || counts.filesCount !== 0) {
				throw new DriveFolderError('HAS_CHILD_FILES_OR_FOLDERS', 'b0fc8a17-963c-405d-bfbc-859a487295e1', 'This folder has child files or folders.');
			}
			await ports.deleteFolder(row.id);
			ports.publish(userId, 'folderDeleted', row.id);
		},
	};
}
