/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { isPureRenote, renderNoteActivity } from '../../../src/modules/federation/public.js';
import { publicFileUrl } from '../../../src/platform/database/note-files.js';
import { createIdCodec } from '../../../src/platform/id-codec.js';
import { loadApDeliverCases, withMentionTagsAsSet } from '../../helpers/ap-deliver-cases.js';
import type { NoteActivityMaterials } from '../../../src/modules/federation/public.js';
import type { RenderCases } from '../../helpers/ap-deliver-cases.js';
import type { MiDriveFile } from 'backend-upstream/entities';

const recorded = loadApDeliverCases<RenderCases>('render-cases.json');
const { inputs } = recorded;
const expected = new Map(recorded.cases.map(c => [c.id, c]));
const users = new Map(inputs.users.map(u => [u.id, u]));
const notes = new Map(inputs.notes.map(n => [n.id, n]));
const codec = createIdCodec('aidx');
const options = { selfUrl: inputs.selfUrl, now: Date.parse(inputs.now) };

// 本家の probe と同じ行を、表現の時点で読めた材料に直す。消えた行と作者のいない返信先は読めなかったものとして扱う。
function materialsFor(c: RenderCases['inputs']['cases'][number]): NoteActivityMaterials {
	const { note } = c;
	const deleted = new Set(c.deletedBeforeRender);
	const row = (id: string | null) => (id === null || deleted.has(id) ? undefined : notes.get(id));
	const reply = row(note.replyId);
	const renote = row(note.renoteId);
	const poll = inputs.polls[note.id];

	return {
		note: {
			id: note.id, userId: note.userId, createdAtMs: codec.createdAtFromId(note.id), text: note.text, cw: note.cw, visibility: note.visibility,
			replyId: note.replyId, renoteId: note.renoteId, renoteUserHost: note.renoteId === null ? null : notes.get(note.renoteId)!.userHost,
			fileIds: note.fileIds, hasPoll: note.hasPoll, tags: note.tags, mentionedRemoteUsers: JSON.parse(note.mentionedRemoteUsers),
		},
		reply: reply && users.has(reply.userId) ? { id: reply.id, uri: reply.uri } : null,
		renote: renote ? { id: renote.id, uri: renote.uri } : null,
		mentionedUsers: note.mentions.flatMap(id => inputs.users.filter(u => u.id === id)),
		files: note.fileIds.flatMap(id => inputs.files.filter(f => f.id === id)).map(file => ({
			type: file.type, webpublicType: file.webpublicType, url: publicFileUrl(file as unknown as MiDriveFile, true, { url: inputs.selfUrl }),
			comment: file.comment, width: file.properties.width, height: file.properties.height, isSensitive: file.isSensitive,
		})),
		poll: note.hasPoll && poll ? { choices: poll.choices, multiple: poll.multiple, votes: poll.votes, expiresAtMs: poll.expiresAt === null ? null : Date.parse(poll.expiresAt) } : null,
		emojis: note.emojis.flatMap(name => inputs.emojis.filter(e => e.name === name)).map(emoji => ({
			name: emoji.name, type: emoji.type, publicUrl: emoji.publicUrl, originalUrl: emoji.originalUrl, license: emoji.license,
			localOnly: emoji.localOnly, updatedAtMs: emoji.updatedAt === null ? null : Date.parse(emoji.updatedAt),
		})),
	};
}

// 本家が配送の区画へ入らなかった投稿。表現より前の条件（localOnly・channel・リモートの作者）で止まり、表現の対象ではない。
const notRendered = new Set(['local-only', 'channel', 'remote-author']);

test('every recorded upstream result has an input case', () => {
	expect(recorded.cases.map(c => c.id)).toEqual(inputs.cases.map(c => c.id));
});

test.for(inputs.cases.filter(c => !notRendered.has(c.id)))('$id renders the same activity as the pinned upstream', c => {
	const upstream = expected.get(c.id)!;

	if (upstream.activity === null) {
		// 本家の記録は例外のメッセージだけを持つ。
		expect(() => renderNoteActivity(materialsFor(c), options)).toThrow(expect.objectContaining({ message: upstream.unhandledRejections[0] }));
		return;
	}

	const activity = JSON.stringify(renderNoteActivity(materialsFor(c), options));
	expect(withMentionTagsAsSet(activity)).toBe(withMentionTagsAsSet(upstream.activity));
});

test('the gated cases are exactly the ones upstream never rendered', () => {
	expect(recorded.cases.filter(c => !c.reachedDeliver && c.unhandledRejections.length === 0).map(c => c.id)).toEqual([...notRendered]);
});

test('mention tags follow the saved mentions order instead of the database order', () => {
	const c = inputs.cases.find(x => x.id === 'public-mentions-db-order')!;

	const activity = renderNoteActivity(materialsFor(c), options) as { object: { tag: { type: string; href: string }[] } };

	const hrefs = c.note.mentions.map(id => {
		const user = users.get(id)!;
		return user.host === null ? `${inputs.selfUrl}/users/${user.id}` : user.uri;
	});
	expect(activity.object.tag.filter(tag => tag.type === 'Mention').map(tag => tag.href)).toEqual(hrefs);
});

test('a pure renote whose remote target vanished before rendering is not announced', () => {
	const c = inputs.cases.find(x => x.id === 'renote-public-remote')!;
	const materials = { ...materialsFor(c), renote: null };

	expect(() => renderNoteActivity(materials, options)).toThrow('renderAnnounce: renote target is gone');
});

type RenoteColumns = Parameters<typeof isPureRenote>[0];

test.for<[string, Partial<RenoteColumns>]>([
	['text', { text: 'x' }],
	['cw', { cw: '' }],
	['reply', { replyId: 'reply' }],
	['poll', { hasPoll: true }],
	['files', { fileIds: ['file'] }],
])('a renote with %s is a quote, not a pure renote', ([, change]) => {
	const base: RenoteColumns = { renoteId: 'renote', text: null, replyId: null, cw: null, hasPoll: false, fileIds: [] };

	expect(isPureRenote(base)).toBe(true);
	expect(isPureRenote({ ...base, ...change })).toBe(false);
	expect(isPureRenote({ ...base, renoteId: null })).toBe(false);
});
