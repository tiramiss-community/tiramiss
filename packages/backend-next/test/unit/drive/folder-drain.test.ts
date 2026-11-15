/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { createDriveFolderPublisher } from '../../../src/platform/drive-folder-publisher.js';
import { registerHttpAppWork } from '../../../src/composition/http-app-work.js';
import { listenHttp, closeHttp, registerHttpDrain } from '../../../src/processes/http.js';
test.each([1, 2])('failed %s HTTP drainers still wait for accepted writes and later publication before reporting errors', async (failures) => {
	let enter!: () => void;
	const entered = new Promise<void>(resolve => {
		enter = resolve;
	});
	let finishWrite!: () => void;
	const writing = new Promise<void>(resolve => {
		finishWrite = resolve;
	});
	let finishPublish!: () => void;
	const publishing = new Promise<number>(resolve => {
		finishPublish = () => resolve(1);
	});
	const publisher = createDriveFolderPublisher({ publish: () => publishing }, 'https://folder.test', { error() { } } as never);
	const app = new Hono().post('/', async (context) => {
		enter();
		await writing;
		publisher.publish('alice', 'folderDeleted', 'saved');
		return context.text('saved');
	});
	registerHttpAppWork(app, publisher.idle);
	const server = await listenHttp(app, { port: 0 });
	const errors = Array.from({ length: failures }, (_, i) => Error(`drainer-${i}`));
	for (const error of errors) {
		registerHttpDrain(server, async () => {
			throw error;
		});
	}
	let closeResult: Promise<unknown> | undefined;
	try {
		const response = fetch(`http://127.0.0.1:${(server.address() as {
			port: number;
		}).port}/`, { method: 'POST' });
		await entered;
		let settled = false;
		closeResult = closeHttp(server).then(() => {
			settled = true;
			return null;
		}, error => {
			settled = true;
			return error;
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		finishWrite();
		expect(await (await response).text()).toBe('saved');
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		finishPublish();
		const error = await closeResult;
		if (failures === 1) {
			expect(error).toBe(errors[0]);
		} else {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual(errors);
		}
	} finally {
		finishWrite();
		finishPublish();
		await closeResult;
		if (server.listening) {
			await closeHttp(server).catch(() => { });
		}
	}
});
