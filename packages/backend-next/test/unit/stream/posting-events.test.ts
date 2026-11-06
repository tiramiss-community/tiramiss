/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createPostingStream } from '../../../src/platform/posting-stream.js';

test('upstream Redis host channel and logical envelopes, without key prefix or notes type wrapper', async () => {
	const published: { channel: string; value: unknown }[] = [];
	const stream = createPostingStream({
		publish: async (channel, value) => {
			published.push({ channel, value: JSON.parse(value) }); return 0;
		}
	}, 'https://example.test:8443');
	await stream.notes({ id: 'n', text: 'secret' });
	await stream.main('u', 'mention', { id: 'n' });
	await stream.deleted({ id: 'n', userId: 'u', visibility: 'specified', visibleUserIds: ['v'] }, 1234);
	expect(published).toEqual([
		{ channel: 'example.test:8443', value: { channel: 'notesStream', message: { id: 'n', text: 'secret' } } },
		{ channel: 'example.test:8443', value: { channel: 'mainStream:u', message: { type: 'mention', body: { id: 'n' } } } },
		{ channel: 'example.test:8443', value: { channel: 'noteStream:n', message: { type: 'deleted', body: { id: 'n', userId: 'u', visibility: 'specified', visibleUserIds: ['v'], body: { deletedAt: '1970-01-01T00:00:01.234Z' } } } } },
	]);
});
