/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiNote } from 'backend-upstream/entities';
import { runChild } from '../../built/entrypoints/run-child.js';
import { startManagedProcess } from '../../built/processes/lifecycle.js';
await runChild('worker', config => startManagedProcess('worker', config, async (resources) => {
	const row = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: process.env.FIXTURE_NOTE_ID });
	const note = { ...row, mentionedRemoteUsers: JSON.parse(row.mentionedRemoteUsers) };
	resources.notePostSave.start({
		noteId: row.id, userId: row.userId, repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null,
		createdSnapshot: {
			note, author: {
				id: row.userId, username: 'remote', host: row.userHost, isBot: false
			}, channel: null, reply: null, renote: null, rawNote: { ...row, reply: null, renote: null }
		},
	});
	await resources.notePostSave.idle();
	return async () => { };
}));
