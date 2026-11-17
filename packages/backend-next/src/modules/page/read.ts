/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput } from '../access/public.js';
import type { AccessRequest } from '../access/public.js';
export interface PageBlock extends Record<string, unknown> { children?: PageBlock[] }
export interface PageRow {
	id: string; userId: string; updatedAt: Date; content: PageBlock[]; variables: Record<string, unknown>[];
	title: string; name: string; summary: string | null; hideTitleWhenPinned: boolean; alignCenter: boolean;
	font: 'serif' | 'sans-serif'; script: string; eyeCatchingImageId: string | null; likedCount: number;
}
export interface PageMaterials {
	user: Record<string, unknown>; attachedFiles: Record<string, unknown>[]; eyeCatchingImage: Record<string, unknown> | null; isLiked?: boolean;
}
export type PageQuery = { pageId: string | null } | { name: string; username: string };
export interface PagePorts {
	findPage(query: PageQuery): Promise<PageRow | null>;
	load(page: PageRow, attachmentIds: readonly (string | null | undefined)[], viewerId: string | null, now: number): Promise<PageMaterials>;
	writeContent(id: string, content: PageBlock[]): Promise<void>;
	writeFailed(error: unknown, id: string): void;
	createdAtFromId(id: string): number;
}
export class PageMissing extends Error {
	readonly code = 'NO_SUCH_PAGE';
	readonly id = '222120c0-3ead-4528-811b-b96f233388d7';
	constructor() {
		super('No such page.');
	}
}
const input = compileInput<PageQuery>({
	anyOf: [
		{ type: 'object', properties: { pageId: { type: 'string', format: 'misskey:id' } }, required: ['pageId'] },
		{ type: 'object', properties: { name: { type: 'string' }, username: { type: 'string' } }, required: ['name', 'username'] },
	]
});
export function migratePageContent(original: readonly PageBlock[]): { content: PageBlock[]; migrated: boolean } {
	const content = structuredClone(original) as PageBlock[];
	let migrated = false;

	function visit(blocks: PageBlock[]) {
		for (const block of blocks) {
			if (block.type === 'input') {
				if (block.inputType === 'text') {
					block.type = 'textInput';
				}
				if (block.inputType === 'number') {
					block.type = 'numberInput';
					if (block.default) {
						block.default = parseInt(String(block.default), 10);
					}
				}
				migrated = true;
			}
			if (block.children) {
				visit(block.children);
			}
		}
	}

	visit(content);
	return { content, migrated };
}
export function pageAttachmentIds(content: readonly PageBlock[]): (string | null | undefined)[] {
	const ids: (string | null | undefined)[] = [];

	function collect(blocks: readonly PageBlock[]) {
		for (const block of blocks) {
			if (block.type === 'image') {
				ids.push(block.fileId as string | null | undefined);
			}
			if (block.children) {
				collect(block.children);
			}
		}
	}

	collect(content);
	return ids;
}
export function renderPage(page: PageRow, content: PageBlock[], materials: PageMaterials, createdAtFromId: PagePorts['createdAtFromId']) {
	return {
		id: page.id, createdAt: new Date(createdAtFromId(page.id)).toISOString(), updatedAt: page.updatedAt.toISOString(),
		userId: page.userId, user: materials.user, content, variables: page.variables, title: page.title, name: page.name,
		summary: page.summary, hideTitleWhenPinned: page.hideTitleWhenPinned, alignCenter: page.alignCenter, font: page.font, script: page.script,
		eyeCatchingImageId: page.eyeCatchingImageId, eyeCatchingImage: materials.eyeCatchingImage,
		attachedFiles: materials.attachedFiles, likedCount: page.likedCount, ...('isLiked' in materials ? { isLiked: materials.isLiked } : {}),
	};
}
export function createPageReader(ports: PagePorts) {
	const pending = new Set<Promise<void>>();

	async function pack(page: PageRow, viewerId: string | null, now: number) {
		const attachments = pageAttachmentIds(page.content);
		const { content, migrated } = migratePageContent(page.content);
		if (migrated) {
			const write = ports.writeContent(page.id, content).catch(error => {
				ports.writeFailed(error, page.id);
			});
			pending.add(write);
			void write.finally(() => {
				pending.delete(write);
			});
		}
		const materials = await ports.load(page, attachments, viewerId, now);
		return renderPage(page, content, materials, ports.createdAtFromId);
	}

	return {
		pack,
		packMany: (pages: readonly PageRow[], viewerId: string | null, now: number) => Promise.all(pages.map(page => pack(page, viewerId, now))),
		async show(access: AccessRequest, value: unknown, now: number) {
			const query = input(value);
			const page = await ports.findPage(query);
			if (!page) {
				throw new PageMissing();
			}
			return pack(page, access.credential?.userId ?? null, now);
		},
		async idle() {
			await Promise.all([...pending]);
		},
	};
}
