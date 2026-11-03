/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createCreateNote } from '../../../src/modules/note/create-note.js';
import { concatNoteContentsForKeywordCheck, matchesWords } from '../../../src/modules/note/keywords.js';
import type { NewNote, NewPoll, NoteAttachableFile, NoteCreateAuthor, NotePostSaveInput, NoteWrites } from '../../../src/modules/note/create-contract.js';

const author: NoteCreateAuthor = { id: 'author', host: null, isSuspended: false, movedToUri: null, canPublicNote: true, rateLimitFactor: 1, sensitiveWords: [], prohibitedWords: [] };
const actor = { userId: 'author', canWriteNote: true };
const ownedFiles: NoteAttachableFile[] = [{ id: 'img', type: 'image/png' }, { id: 'vid', type: 'video/mp4' }];
const now = 1_000_000;

function setup(facts: NoteCreateAuthor | null = author, options: { files?: NoteAttachableFile[]; failPoll?: boolean; failRender?: boolean } = {}) {
	const events: string[] = [];
	const notes: NewNote[] = [];
	const polls: NewPoll[] = [];
	const after: NotePostSaveInput[] = [];
	const fileReads: [string, string[]][] = [];
	const files = options.files ?? ownedFiles;
	const writes = (scope: string): NoteWrites => ({
		insertNote: async note => {
			events.push(`${scope}:note`);
			notes.push(note);
		},
		insertPoll: async poll => {
			events.push(`${scope}:poll`);
			if (options.failPoll) {
				throw new Error('poll insert failed');
			}
			polls.push(poll);
		},
	});
	const create = createCreateNote({
		readAuthor: async () => facts,
		limit: async () => {},
		readOwnedFiles: async (userId, ids) => {
			events.push('files');
			fileReads.push([userId, ids]);
			return ids.flatMap(id => files.filter(file => file.id === id));
		},
		writes: writes('root'),
		transactions: { run: async work => {
			events.push('begin');
			const result = await work(writes('tx'));
			events.push('commit');
			return result;
		} },
		afterSaved: input => {
			events.push('after');
			after.push(input);
		},
		newId: () => 'new',
		matchesWords,
	});
	const render = async (id: string, viewerId: string) => {
		events.push(`render:${id}:${viewerId}`);
		if (options.failRender) {
			throw new Error('render failed');
		}
		return { id };
	};
	return { createNote: (input: unknown, credential: typeof actor | null = actor) => create.createNote(credential, input, now, render), events, notes, polls, after, fileReads };
}

test('text is trimmed and plain persisted fields do not depend on HTTP or ORM', async () => {
	const { createNote, notes, polls, after, events } = setup();
	expect(await createNote({ text: '  hello  ' })).toEqual({ id: 'new' });
	expect(notes).toEqual([{ id: 'new', userId: 'author', userHost: null, text: 'hello', cw: null, visibility: 'public', localOnly: false, reactionAcceptance: null, channelId: null, fileIds: [], attachedFileTypes: [], hasPoll: false }]);
	expect(polls).toEqual([]);
	expect(after).toEqual([{ userId: 'author' }]);
	// 本家 NoteCreateService.ts:704-726: 投票なしは transaction を使わない単独 insert。
	expect(events).toEqual(['root:note', 'render:new:author', 'after']);
});

test.each([
	[{ sensitiveWords: ['needle'] }, { text: 'needle' }, 'home'],
	[{ sensitiveWords: ['needle'] }, { text: 'needle', cw: 'safe' }, 'public'],
	[{ sensitiveWords: ['needle'] }, { text: 'safe', cw: 'needle' }, 'home'],
	[{ canPublicNote: false }, { text: 'hello' }, 'home'],
	[{ canPublicNote: false }, { text: 'hello', visibility: 'followers' }, 'followers'],
] as const)('public visibility correction with %j and %j', async (facts, input, visibility) => {
	const { createNote, notes } = setup({ ...author, ...facts, sensitiveWords: [...('sensitiveWords' in facts ? facts.sensitiveWords : [])] });
	await createNote(input);
	expect(notes[0].visibility).toBe(visibility);
});

test.each(['ab', 'a b', '/^ab/m'])('prohibited words %s examine CW concatenated with text', async word => {
	const { createNote, notes } = setup({ ...author, prohibitedWords: [word] });
	await expect(createNote({ text: 'b', cw: 'a' })).rejects.toMatchObject({ code: 'CONTAINS_PROHIBITED_WORDS' });
	expect(notes).toEqual([]);
});

test('keyword matching uses AND terms, RE2 flags, and ignores invalid expressions', () => {
	expect(matchesWords('Foo BAR', ['Foo BAR'])).toBe(true);
	expect(matchesWords('Foo', ['Foo BAR'])).toBe(false);
	expect(matchesWords('Foo', ['/foo/i'])).toBe(true);
	expect(matchesWords('Foo', ['/[bad/'])).toBe(false);
	expect(matchesWords('Foo', ['/(?=Foo)/'])).toBe(false);
});

// 本家 UtilityService.ts:70-81 の連結形。
test('prohibited word contents join cw and text directly, then poll choices on separate lines', () => {
	expect(concatNoteContentsForKeywordCheck({ cw: 'a', text: 'b', pollChoices: [] })).toBe('ab\n\n');
	expect(concatNoteContentsForKeywordCheck({ cw: null, text: null, pollChoices: ['x', 'y'] })).toBe('\nx\ny\n');
});

// 本家 NoteCreateService.ts:472-489: sensitiveWords は cw ?? text だけ、禁止語は選択肢と trim 前の text も見る。
test('prohibited words reach poll choices and untrimmed text while sensitive words ignore choices', async () => {
	const prohibited = setup({ ...author, prohibitedWords: ['forbidden'] });
	await expect(prohibited.createNote({ text: 'ok', poll: { choices: ['fine', 'forbidden'] } })).rejects.toMatchObject({ code: 'CONTAINS_PROHIBITED_WORDS' });
	const spaced = setup({ ...author, prohibitedWords: ['/^\\s+lead/'] });
	await expect(spaced.createNote({ text: '  lead' })).rejects.toMatchObject({ code: 'CONTAINS_PROHIBITED_WORDS' });
	const sensitive = setup({ ...author, sensitiveWords: ['needle'] });
	await sensitive.createNote({ text: 'safe', poll: { choices: ['needle', 'b'] } });
	expect(sensitive.notes[0].visibility).toBe('public');
	expect([prohibited.notes, spaced.notes, prohibited.polls]).toEqual([[], [], []]);
});

test('rate executes before suspended, moved, scope and schema; factor<=0 skips rate', async () => {
	const events: string[] = [];
	const writes: NoteWrites = { insertNote: async () => {
		events.push('insert');
	}, insertPoll: async () => {} };
	const dependencies = {
		readOwnedFiles: async () => [], writes, transactions: { run: async <T>(work: (scope: NoteWrites) => Promise<T>) => work(writes) },
		afterSaved: () => {}, newId: () => 'new', matchesWords,
	};
	const create = createCreateNote({
		...dependencies,
		readAuthor: async () => ({ ...author, isSuspended: true }),
		limit: async (_id, factor) => {
			events.push(`rate:${factor}`);
			throw new Error('rate failure');
		},
	});
	await expect(create.createNote({ ...actor, canWriteNote: false }, {}, 123, async id => id)).rejects.toThrow('rate failure');
	expect(events).toEqual(['rate:1']);
	const noLimit = createCreateNote({ ...dependencies, readAuthor: async () => ({ ...author, rateLimitFactor: 0 }), limit: async () => {
		throw new Error('must skip');
	} });
	expect(await noLimit.createNote(actor, { text: 'hello' }, 123, async id => id)).toBe('new');
});

test.each([
	[null, actor, 'AUTHENTICATION_FAILED'],
	[author, null, 'CREDENTIAL_REQUIRED'],
	[{ ...author, isSuspended: true }, actor, 'YOUR_ACCOUNT_SUSPENDED'],
	[{ ...author, movedToUri: 'https://moved.test/' }, actor, 'YOUR_ACCOUNT_MOVED'],
	[author, { ...actor, canWriteNote: false }, 'PERMISSION_DENIED'],
] as const)('credentials and actor facts reject before invalid input (%s)', async (facts, credential, code) => {
	const { createNote, notes } = setup(facts);
	await expect(createNote({}, credential)).rejects.toMatchObject({ code });
	expect(notes).toEqual([]);
});

test('an insert failure is not retried and never renders or starts post-save work', async () => {
	let inserts = 0;
	const events: string[] = [];
	const writes: NoteWrites = { insertNote: async () => {
		inserts++; throw new Error('DB outcome unknown');
	}, insertPoll: async () => {} };
	const create = createCreateNote({ readAuthor: async () => author, readOwnedFiles: async () => [], writes, transactions: { run: work => work(writes) }, afterSaved: () => {
		events.push('after');
	}, newId: () => 'new', limit: async () => {}, matchesWords });
	await expect(create.createNote(actor, { text: 'hello' }, 123, async id => {
		events.push('render');
		return id;
	})).rejects.toThrow('DB outcome unknown');
	expect(inserts).toBe(1);
	expect(events).toEqual([]);
});

test('post-save work starts after rendering, even when rendering a saved Note fails', async () => {
	const { createNote, events, notes } = setup(author, { failRender: true });
	await expect(createNote({ text: 'hello' })).rejects.toThrow('render failed');
	expect(notes).toHaveLength(1);
	expect(events).toEqual(['root:note', 'render:new:author', 'after']);
});

test('MFM detection uses trimmed text so whitespace around fenced literal mentions is accepted', async () => {
	const { createNote, notes } = setup();
	await expect(createNote({ text: '  ```\n@foo\n``` ' })).resolves.toEqual({ id: 'new' });
	expect(notes[0].text).toBe('```\n@foo\n```');
});

// 本家 notes/create.ts:226 と NoteCreateService.ts:304-317,648,673。
test('attachments keep requested order and MIME types, and fileIds hide mediaIds entirely', async () => {
	const { createNote, notes, fileReads } = setup();
	await createNote({ fileIds: ['vid', 'img'], mediaIds: ['missing'] });
	expect(fileReads).toEqual([['author', ['vid', 'img']]]);
	expect(notes[0]).toMatchObject({ text: null, fileIds: ['vid', 'img'], attachedFileTypes: ['video/mp4', 'image/png'] });
	const alias = setup();
	await alias.createNote({ mediaIds: ['img'] });
	expect(alias.notes[0]).toMatchObject({ fileIds: ['img'], attachedFileTypes: ['image/png'] });
});

// 本家 NoteCreateService.ts:573-582: 添付・投票があれば空白だけの text はスキーマを通り、trim で null になる。
test.each([
	[{ text: '  \n ', fileIds: ['img'] }],
	[{ text: ' ', poll: { choices: ['a', 'b'] } }],
])('whitespace-only text with %j is stored as null', async input => {
	const { createNote, notes } = setup();
	await createNote(input);
	expect(notes[0].text).toBeNull();
});

test('missing or foreign attachments are indistinguishable and save nothing', async () => {
	const { createNote, notes, events } = setup(author, { files: [{ id: 'img', type: 'image/png' }] });
	await expect(createNote({ text: 'file', fileIds: ['img', 'foreign'] })).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	expect(notes).toEqual([]);
	expect(events).toEqual(['files']);
});

// 本家 NoteCreateService.ts:300-420 の後に create() の 481-489 が来る。
test.each([
	[{ text: 'forbidden', fileIds: ['missing'], renoteId: 'x', poll: { choices: ['a', 'b'], expiresAt: 1 } }, 'NO_SUCH_FILE'],
	[{ text: 'forbidden', fileIds: ['img'], renoteId: 'x', poll: { choices: ['a', 'b'], expiresAt: 1 } }, 'NOT_IMPLEMENTED'],
	[{ text: 'forbidden', fileIds: ['img'], poll: { choices: ['a', 'b'], expiresAt: 1 }, channelId: 'x' }, 'CANNOT_CREATE_ALREADY_EXPIRED_POLL'],
	[{ text: 'forbidden', poll: { choices: ['@probe', 'b'] } }, 'CONTAINS_PROHIBITED_WORDS'],
	[{ text: 'fine', poll: { choices: ['@probe', 'b'] } }, 'NOT_IMPLEMENTED'],
	[{ text: 'fine', poll: { choices: ['#tag', 'b'] }, noExtractHashtags: true }, null],
] as const)('related checks precede word checks: %j', async (input, code) => {
	const { createNote, notes } = setup({ ...author, prohibitedWords: ['forbidden'] });
	if (code === null) {
		await createNote(input);
		expect(notes).toHaveLength(1);
		return;
	}
	await expect(createNote(input)).rejects.toMatchObject({ code });
	expect(notes).toEqual([]);
});

// 本家 notes/create.ts:227-231 と NoteCreateService.ts:404-411。
test.each([
	[{ choices: ['a', 'b'] }, false, null],
	[{ choices: ['a', 'b'], multiple: true, expiresAt: 0 }, true, null],
	[{ choices: ['a', 'b'], expiresAt: now }, false, now],
	[{ choices: ['a', 'b'], expiresAt: 1, expiredAfter: 600000 }, false, now + 600000],
])('poll %j stores multiple=%s and expiresAt=%s', async (poll, multiple, expiresAtMs) => {
	const { createNote, polls } = setup();
	await createNote({ text: 'poll', poll });
	expect(polls[0]).toMatchObject({ multiple, expiresAtMs });
});

test('a poll whose deadline is before the request time is rejected', async () => {
	const { createNote, notes } = setup();
	await expect(createNote({ text: 'poll', poll: { choices: ['a', 'b'], expiresAt: now - 1 } })).rejects.toMatchObject({ code: 'CANNOT_CREATE_ALREADY_EXPIRED_POLL' });
	expect(notes).toEqual([]);
});

// 本家 NoteCreateService.ts:704-726: Poll 行は補正後の公開範囲と作者の host を持ち、Note と同じ transaction で入る。
test('a poll is saved with its Note in one transaction and copies corrected Note facts', async () => {
	const { createNote, notes, polls, events } = setup({ ...author, sensitiveWords: ['needle'] });
	await createNote({ text: 'needle', poll: { choices: ['a', 'b', 'c'] } });
	expect(notes[0]).toMatchObject({ visibility: 'home', hasPoll: true });
	expect(polls).toEqual([{ noteId: 'new', choices: ['a', 'b', 'c'], multiple: false, expiresAtMs: null, votes: [0, 0, 0], noteVisibility: 'home', userId: 'author', userHost: null, channelId: null }]);
	expect(events).toEqual(['begin', 'tx:note', 'tx:poll', 'commit', 'render:new:author', 'after']);
});

test('a failing poll insert surfaces before rendering or post-save work', async () => {
	const { createNote, events } = setup(author, { failPoll: true });
	await expect(createNote({ text: 'poll', poll: { choices: ['a', 'b'] } })).rejects.toThrow('poll insert failed');
	expect(events).toEqual(['begin', 'tx:note', 'tx:poll']);
});
