/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createAccessRequest, InputInvalid } from '../../../src/modules/access/public.js';
import { createDriveFolders, DriveFolderError } from '../../../src/modules/drive/folders.js';
import { createIdCodec } from '../../../src/platform/id-codec.js';
import type { DriveFolderRow, DriveFolderPorts } from '../../../src/modules/drive/folders.js';
const directory = new URL('../../../../../docs/superpowers/compatibility/drive-folders/', import.meta.url);
interface Case {
	id: string;
	operation: 'create' | 'delete' | 'find' | 'show' | 'update';
	input: unknown;
	extra?: DriveFolderRow[];
	files?: {
		folderId: string;
	}[];
	fail?: string;
}
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	rows: DriveFolderRow[];
	actorId: string;
	newId: string;
	cases: Case[];
};
const observations = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	cases: {
		id: string;
		expected: unknown;
	}[];
};
for (const c of corpus.cases) {
	test(`fixed-source folder ${c.id}`, async () => {
		let rows = structuredClone([...corpus.rows, ...c.extra ?? []]);
		const events: unknown[] = [];
		const ports: DriveFolderPorts = {
			async readActor() {
				return { isSuspended: false, isModerator: false, isAdministrator: false, rateLimitFactor: 1 };
			},
			async limit() { },
			async readFolder(id, userId) {
				if (c.fail === 'ancestor' && userId === undefined && id === corpus.rows[0].id) {
					return null;
				}
				return structuredClone(rows.find(r => r.id === id && (userId === undefined || r.userId === userId)) ?? null);
			},
			async findFolders(name, parentId, userId) {
				return rows.filter(r => r.name === name && r.parentId === parentId && r.userId === userId);
			},
			async readCounts(id) {
				return { foldersCount: rows.filter(r => r.parentId === id).length, filesCount: (c.files ?? []).filter(r => r.folderId === id).length };
			},
			async insertFolder(row) {
				if (c.fail === 'insert') {
					throw Error('insert unavailable');
				}
				rows.push(structuredClone(row));
			},
			async updateFolder(row) {
				if (c.fail === 'update') {
					throw Error('update unavailable');
				}
				rows = rows.map(r => r.id === row.id ? { ...r, name: row.name, parentId: row.parentId } : r);
			},
			async deleteFolder(id) {
				if (c.fail === 'delete') {
					throw Error('delete unavailable');
				}
				rows = rows.filter(r => r.id !== id);
			},
			publish(userId, type, body) {
				events.push({ userId, type, body });
			},
			newId: () => corpus.newId, createdAtFromId: createIdCodec('aidx').createdAtFromId,
		};
		const app = createDriveFolders(ports);
		const access = createAccessRequest({ requireCredential: true, kind: ['find', 'show'].includes(c.operation) ? 'read:drive' : 'write:drive' }, { userId: corpus.actorId, native: true });
		let result: unknown;
		let error: unknown;
		try {
			result = await app[c.operation](access, structuredClone(c.input), 0);
		} catch (e) {
			error = e instanceof InputInvalid ? { code: 'INVALID_PARAM' } : e instanceof DriveFolderError ? { code: e.code, id: e.id } : { message: (e as Error).message };
		}
		expect(JSON.parse(JSON.stringify({ ...(result === undefined ? {} : { result }), ...(error ? { error } : {}), rows, events }))).toEqual(observations.cases.find(r => r.id === c.id)!.expected);
	});
}
const sourceGate = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	gateCases: {
		id: string;
		calls: string[];
		error?: string;
	}[];
};
for (const c of [
	{ id: 'scope-before-input', scope: false },
	{ id: 'suspended-before-scope', suspended: true, scope: false },
	{ id: 'quota-before-suspended-and-scope', suspended: true, scope: false, exceeded: true },
	{ id: 'redis-before-suspended-and-scope', suspended: true, scope: false, fail: true },
	{ id: 'factor-zero', factor: 0, scope: true },
]) {
	test(`literal ApiCallService gate ordering ${c.id}`, async () => {
		const calls: string[] = [];
		const application = createDriveFolders({
			async readActor() {
				calls.push('policy');
				return { isSuspended: c.suspended ?? false, isModerator: false, isAdministrator: false, rateLimitFactor: c.factor ?? 1 };
			},
			async limit() {
				calls.push('limit');
				if (c.fail) {
					throw Error('Redis unavailable');
				}
				if (c.exceeded) {
					throw new DriveFolderError('RATE_LIMIT_EXCEEDED', '', 'exceeded');
				}
			},
			async readFolder() {
				return null;
			}, async findFolders() {
				return [];
			}, async readCounts() {
				return { filesCount: 0, foldersCount: 0 };
			},
			async insertFolder() { }, async updateFolder() { }, async deleteFolder() { }, publish() { }, newId: () => corpus.newId, createdAtFromId: createIdCodec('aidx').createdAtFromId,
		});
		const access = createAccessRequest({ requireCredential: true, kind: 'write:drive' }, { userId: 'alice', native: false, permissions: new Set(c.scope ? ['write:drive'] : []) });
		let error: string | undefined;
		try {
			await application.create(access, {}, 0);
		} catch (e) {
			error = 'reason' in (e as object) ? (e as {
				reason: string;
			}).reason : 'code' in (e as object) ? (e as {
				code: string;
			}).code : (e as Error).message;
		}
		expect({ id: c.id, calls, ...(error ? { error } : {}) }).toEqual(sourceGate.gateCases.find(row => row.id === c.id));
	});
}
