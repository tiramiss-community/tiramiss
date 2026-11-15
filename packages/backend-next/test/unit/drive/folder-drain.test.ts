/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createDriveFolderPublisher } from '../../../src/platform/drive-folder-publisher.js';
import { createLogger } from '../../../src/platform/logger.js';
test('publication starts without waiting and idle settles only after the accepted send', async () => {
	let release!: () => void;
	const sending = new Promise<void>(resolve => {
		release = resolve;
	});
	const publisher = createDriveFolderPublisher(() => sending, createLogger('folder-publish-test', () => { }));
	expect(publisher.publish('alice', 'folderDeleted', 'folder')).toBeUndefined();
	let settled = false;
	const idle = publisher.idle().then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	release();
	await idle;
	expect(settled).toBe(true);
});
test('a failed publication is diagnosed and clears accepted pending work without rejecting idle', async () => {
	const lines: string[] = [];
	const publisher = createDriveFolderPublisher(async () => {
		throw Error('pubsub unavailable');
	}, createLogger('folder-publish-test', line => lines.push(line)));
	publisher.publish('alice', 'folderDeleted', 'folder');
	await expect(publisher.idle()).resolves.toBeUndefined();
	expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'drive-folder-publish.failed', userId: 'alice', type: 'folderDeleted' }));
});
