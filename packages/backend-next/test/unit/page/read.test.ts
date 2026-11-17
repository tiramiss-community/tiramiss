/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createPageReader, migratePageContent } from '../../../src/modules/page/read.js';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import type { PageRow, PagePorts } from '../../../src/modules/page/read.js';
const row: PageRow = { id: 'page', userId: 'owner', updatedAt: new Date(0), content: [], variables: [], title: 'Title', name: 'name', summary: null, hideTitleWhenPinned: false, alignCenter: true, font: 'serif', script: '', eyeCatchingImageId: null, likedCount: 4 };

function fixture(page = row) {
	const writes: unknown[] = [], failures: unknown[] = [];
	const ports: PagePorts = {
		findPage: async () => structuredClone(page),
		load: async (_page, _ids, viewerId) => ({ user: { id: 'owner' }, attachedFiles: [], eyeCatchingImage: null, ...(viewerId ? { isLiked: true } : {}) }),
		writeContent: async (id, content) => {
			writes.push({ id, content });
		},
		writeFailed: error => {
			failures.push(error);
		}, createdAtFromId: () => 0,
	};
	return { ports, writes, failures, reader: createPageReader(ports) };
}

test('recursively migrates legacy input without changing retrieved facts, preserving truthiness and unknown input', () => {
	const content = [{ type: 'section', children: [{ type: 'input', inputType: 'number', default: '12abc' }, { type: 'input', inputType: 'text' }, { type: 'input', inputType: 'unknown' }, { type: 'input', inputType: 'number', default: '' }] }];
	const result = migratePageContent(content);
	expect(result.migrated).toBe(true);
	expect(result.content[0].children).toEqual([{ type: 'numberInput', inputType: 'number', default: 12 }, { type: 'textInput', inputType: 'text' }, { type: 'input', inputType: 'unknown' }, { type: 'numberInput', inputType: 'number', default: '' }]);
	expect(content[0].children[0].type).toBe('input');
});
test('packs preloaded materials with duplicate nested attachment requests and guest like omission', async () => {
	const page = { ...row, content: [{ type: 'image', fileId: 'one', children: [{ type: 'image', fileId: 'one' }] }] };
	const f = fixture(page); let requested: readonly (string | null | undefined)[] = [];
	f.ports.load = async (_page, ids) => {
		requested = ids; return { user: { id: 'owner' }, attachedFiles: [{ id: 'one' }, { id: 'one' }], eyeCatchingImage: null };
	};
	const result = await f.reader.show(createAccessRequest({}, null), { pageId: 'page' }, 0);
	expect(requested).toEqual(['one', 'one']);
	expect(result).toMatchObject({ id: 'page', createdAt: '1970-01-01T00:00:00.000Z', attachedFiles: [{ id: 'one' }, { id: 'one' }] });
	expect(result).not.toHaveProperty('isLiked'); expect(f.writes).toEqual([]);
});
test('legacy write starts without delaying response, failure is diagnosed and drain waits', async () => {
	const f = fixture({ ...row, content: [{ type: 'input', inputType: 'text' }] });
	let reject!: (error: Error) => void; let started = false;
	f.ports.writeContent = () => {
		started = true; return new Promise((_resolve, r) => {
			reject = r;
		});
	};
	const view = await f.reader.pack({ ...row, content: [{ type: 'input', inputType: 'text' }] }, 'viewer', 0);
	expect(started).toBe(true); expect(view.isLiked).toBe(true);
	expect(view.content).toEqual([{ type: 'textInput', inputType: 'text' }]);
	const failure = Error('write failed'); reject(failure); await f.reader.idle();
	expect(f.failures).toEqual([failure]);
});
test('migration write survives subsequent material failure and no page returns fixed error', async () => {
	const f = fixture({ ...row, content: [{ type: 'input' }] });
	f.ports.load = async () => {
		throw Error('eye catch missing');
	};
	await expect(f.reader.show(createAccessRequest({}, null), { pageId: 'page' }, 0)).rejects.toThrow('eye catch missing');
	await f.reader.idle(); expect(f.writes).toHaveLength(1);
	f.ports.findPage = async () => null;
	await expect(f.reader.show(createAccessRequest({}, null), { name: 'x', username: 'OWNER' }, 0)).rejects.toMatchObject({ code: 'NO_SUCH_PAGE', id: '222120c0-3ead-4528-811b-b96f233388d7' });
});
test('packs multiple pages with viewer state and independently migrates each legacy content', async () => {
	const f = fixture();
	const results = await f.reader.packMany([{ ...row, content: [{ type: 'input', inputType: 'text' }] }, { ...row, id: 'second' }], 'viewer', 0);
	await f.reader.idle();
	expect(results.map(page => ({ id: page.id, liked: page.isLiked, content: page.content }))).toEqual([
		{ id: 'page', liked: true, content: [{ type: 'textInput', inputType: 'text' }] }, { id: 'second', liked: true, content: [] },
	]);
	expect(f.writes).toEqual([{ id: 'page', content: [{ type: 'textInput', inputType: 'text' }] }]);
});
