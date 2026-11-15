/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { DriveFolderPorts } from '../modules/drive/folders.js';
import type { Logger } from './logger.js';
/** The source starts publication after the write without delaying the response. */
export function createDriveFolderPublisher(send: (...args: Parameters<DriveFolderPorts['publish']>) => Promise<void>, logger: Logger) {
	const pending = new Set<Promise<void>>();
	const publish: DriveFolderPorts['publish'] = (userId, type, body) => {
		const work = Promise.resolve().then(() => send(userId, type, body)).then(() => { }, error => {
			logger.error('drive-folder-publish.failed', { userId, type, error });
		});
		pending.add(work);
		void work.then(() => pending.delete(work));
	};
	return {
		publish,
		async idle(): Promise<void> {
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
		},
	};
}
