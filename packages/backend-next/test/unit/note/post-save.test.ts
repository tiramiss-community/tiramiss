/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createNotePostSave } from '../../../src/platform/note-post-save.js';
import { createLogger } from '../../../src/platform/logger.js';

test('post-save failure is logged, does not escape to HTTP, and shutdown waits for started work', async () => {
	const logs: string[] = [];
	let complete!: () => void;
	const blocked = new Promise<void>(resolve => {
		complete = resolve;
	});
	const updated: string[] = [];
	const effects = createNotePostSave(async id => {
		await blocked;
		if (id === 'broken') {
			throw new Error('count unavailable');
		}
		updated.push(id);
	}, createLogger('test', line => logs.push(line)));
	effects.start('saved');
	effects.start('broken');
	let closed = false;
	const closing = effects.close().then(() => {
		closed = true;
	});
	await new Promise<void>(resolve => setImmediate(resolve));
	expect(closed).toBe(false);
	complete();
	await closing;
	expect(updated).toEqual(['saved']);
	expect(logs.map(line => JSON.parse(line).event)).toContain('note-post-save.failed');
});
