/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createCreateNote } from '../../../src/modules/note/create-note.js';
import { matchesWords } from '../../../src/modules/note/keywords.js';
import type { NoteCreateAuthor, NewTextNote } from '../../../src/modules/note/create-contract.js';

const author: NoteCreateAuthor = { id: 'author', isSuspended: false, movedToUri: null, canPublicNote: true, rateLimitFactor: 1, sensitiveWords: [], prohibitedWords: [] };
const actor = { userId: 'author', canWriteNote: true };

function setup(facts: NoteCreateAuthor | null = author) {
	const notes: NewTextNote[] = [];
	const after: string[] = [];
	const create = createCreateNote({ readAuthor: async () => facts, insert: async note => {
		notes.push(note);
	}, afterSaved: note => {
		after.push(note.id);
	}, limit: async () => {}, newId: () => 'new', matchesWords });
	return { ...create, notes, after };
}

test('text is trimmed and plain persisted fields do not depend on HTTP or ORM', async () => {
	const { createNote, notes, after } = setup();
	expect(await createNote(actor, { text: '  hello  ' }, 123)).toBe('new');
	expect(notes).toEqual([{ id: 'new', userId: 'author', text: 'hello', cw: null, visibility: 'public', localOnly: false, reactionAcceptance: null }]);
	expect(after).toEqual(['new']);
});

test.each([
	[{ sensitiveWords: ['needle'] }, { text: 'needle' }, 'home'],
	[{ sensitiveWords: ['needle'] }, { text: 'needle', cw: 'safe' }, 'public'],
	[{ sensitiveWords: ['needle'] }, { text: 'safe', cw: 'needle' }, 'home'],
	[{ canPublicNote: false }, { text: 'hello' }, 'home'],
	[{ canPublicNote: false }, { text: 'hello', visibility: 'followers' }, 'followers'],
] as const)('public visibility correction with %j and %j', async (facts, input, visibility) => {
	const { createNote, notes } = setup({ ...author, ...facts, sensitiveWords: [...('sensitiveWords' in facts ? facts.sensitiveWords : [])] });
	await createNote(actor, input, 123);
	expect(notes[0].visibility).toBe(visibility);
});

test.each(['ab', 'a b', '/^ab/m'])('prohibited words %s examine CW concatenated with text', async word => {
	const { createNote, notes } = setup({ ...author, prohibitedWords: [word] });
	await expect(createNote(actor, { text: 'b', cw: 'a' }, 123)).rejects.toMatchObject({ code: 'CONTAINS_PROHIBITED_WORDS' });
	expect(notes).toEqual([]);
});

test('keyword matching uses AND terms, RE2 flags, and ignores invalid expressions', () => {
	expect(matchesWords('Foo BAR', ['Foo BAR'])).toBe(true);
	expect(matchesWords('Foo', ['Foo BAR'])).toBe(false);
	expect(matchesWords('Foo', ['/foo/i'])).toBe(true);
	expect(matchesWords('Foo', ['/[bad/'])).toBe(false);
	expect(matchesWords('Foo', ['/(?=Foo)/'])).toBe(false);
});

test('rate executes before suspended, moved, scope and schema; factor<=0 skips rate', async () => {
	const events: string[] = [];
	const create = createCreateNote({
		readAuthor: async () => ({ ...author, isSuspended: true }),
		insert: async () => {
			events.push('insert');
		},
		afterSaved: () => {}, newId: () => 'new', matchesWords,
		limit: async (_id, factor) => {
			events.push(`rate:${factor}`);
			throw new Error('rate failure');
		},
	});
	await expect(create.createNote({ ...actor, canWriteNote: false }, {}, 123)).rejects.toThrow('rate failure');
	expect(events).toEqual(['rate:1']);
	const noLimit = createCreateNote({ readAuthor: async () => ({ ...author, rateLimitFactor: 0 }), insert: async () => {}, afterSaved: () => {}, newId: () => 'new', matchesWords, limit: async () => {
		throw new Error('must skip');
	} });
	expect(await noLimit.createNote(actor, { text: 'hello' }, 123)).toBe('new');
});

test.each([
	[null, actor, 'AUTHENTICATION_FAILED'],
	[author, null, 'CREDENTIAL_REQUIRED'],
	[{ ...author, isSuspended: true }, actor, 'YOUR_ACCOUNT_SUSPENDED'],
	[{ ...author, movedToUri: 'https://moved.test/' }, actor, 'YOUR_ACCOUNT_MOVED'],
	[author, { ...actor, canWriteNote: false }, 'PERMISSION_DENIED'],
] as const)('credentials and actor facts reject before invalid input (%s)', async (facts, credential, code) => {
	const { createNote, notes } = setup(facts);
	await expect(createNote(credential, {}, 123)).rejects.toMatchObject({ code });
	expect(notes).toEqual([]);
});

test('an insert failure is not retried and never starts post-save work', async () => {
	let inserts = 0;
	let started = false;
	const create = createCreateNote({ readAuthor: async () => author, insert: async () => {
		inserts++; throw new Error('DB outcome unknown');
	}, afterSaved: () => {
		started = true;
	}, newId: () => 'new', limit: async () => {}, matchesWords });
	await expect(create.createNote(actor, { text: 'hello' }, 123)).rejects.toThrow('DB outcome unknown');
	expect(inserts).toBe(1);
	expect(started).toBe(false);
});

test('MFM detection uses trimmed text so whitespace around fenced literal mentions is accepted', async () => {
	const { createNote, notes } = setup();
	await expect(createNote(actor, { text: '  ```\n@foo\n``` ' }, 123)).resolves.toBe('new');
	expect(notes[0].text).toBe('```\n@foo\n```');
});
