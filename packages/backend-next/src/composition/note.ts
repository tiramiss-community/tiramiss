/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createCreateNote, matchesWords } from '../modules/note/public.js';
import { createNoteWriter, createNoteWriteTransactions } from '../platform/database/note-writer.js';
import type { DataSource } from 'typeorm';
import type { RemoteUserPorts } from '../modules/federation/public.js';
import type { NotePostSaveInput } from '../modules/note/public.js';
import type { RoleMaterialReader } from '../platform/role-material-cache.js';

export interface NoteApplicationDependencies {
	dataSource: DataSource;
	roleMaterials: RoleMaterialReader;
	ids: {
		newId(atMs: number): string;
		createdAtFromId(id: string): number;
	};
	clock(): number;
	remoteUsers: RemoteUserPorts;
	limit(userId: string, factor: number): Promise<void>;
	afterSaved(input: NotePostSaveInput): void;
}

export type NoteApplication = ReturnType<typeof createCreateNote>;

export function createNoteApplication(parts: NoteApplicationDependencies): NoteApplication {
	return createCreateNote({
		...createNoteWriter(parts.dataSource.manager, parts.roleMaterials, parts.ids.createdAtFromId),
		transactions: createNoteWriteTransactions(parts.dataSource),
		newId: parts.ids.newId, currentTime: parts.clock, matchesWords,
		remoteUsers: parts.remoteUsers, limit: parts.limit, afterSaved: parts.afterSaved,
	});
}
