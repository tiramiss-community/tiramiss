/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { MiDriveFile, MiDriveFolder, MiMeta } from 'backend-upstream/entities';
import { createDriveFileStore } from '../../../src/platform/database/drive-files.js';
import type { EntityManager } from 'typeorm';
import type { DriveFileFacts } from '../../../src/modules/drive/files-public.js';

function file(folderId: string): DriveFileFacts {
	return {
		id: `file${folderId}`, folderId, userId: null, userHost: null, name: 'f', type: 'image/png', md5: '', size: 1,
		isSensitive: false, blurhash: null, properties: {}, url: 'https://local/f', webpublicUrl: null, thumbnailUrl: null,
		uri: null, isLink: false, webpublicAccessKey: null, comment: null,
	};
}

function store(parents: Record<string, string | null>) {
	const reads: string[] = [];
	const folderRepository = {
		async findOneBy({ id }: { id: string }) {
			reads.push(id);
			return { id, userId: null, name: id, parentId: parents[id] };
		},
		async countBy() {
			return 0;
		},
	};
	const manager = { getRepository(entity: unknown) {
		if (entity === MiDriveFolder) {
			return folderRepository;
		}
		if (entity === MiDriveFile) {
			return { countBy: async () => 0 };
		}
		if (entity === MiMeta) {
			return { find: async () => [{ proxyRemoteFiles: false }] };
		}
		throw Error('unexpected repository');
	} } as unknown as EntityManager;
	return { reader: createDriveFileStore(manager, { url: 'https://local', createdAtFromId: () => 0 }), reads };
}

test('mixed folder snapshots that form a cycle fail before recursive rendering', async () => {
	// Each row can come from an acyclic state before/after concurrent legal moves.
	const { reader } = store({ child: 'parent', parent: 'child' });
	await expect(reader.preload([file('child')], { detail: true }, 0)).rejects.toThrow('Drive folder hierarchy contains a cycle.');
});
test('different folder paths may reuse a previously acquired ancestor', async () => {
	const { reader, reads } = store({ first: 'parent', second: 'parent', parent: null });
	const materials = await reader.preload([file('first'), file('second')], { detail: true }, 0);
	expect(materials.folders?.get('first')).toMatchObject({ id: 'first', parent: { id: 'parent' } });
	expect(materials.folders?.get('second')).toMatchObject({ id: 'second', parent: { id: 'parent' } });
	expect(reads.filter(id => id === 'parent')).toHaveLength(1);
});
