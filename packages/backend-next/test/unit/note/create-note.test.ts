/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createCreateNote } from '../../../src/modules/note/create-note.js';
import { concatNoteContentsForKeywordCheck, matchesWords } from '../../../src/modules/note/keywords.js';
import type { MentionedRemoteUser, NewNote, NewPoll, NoteAttachableFile, NoteCreateAuthor, NotePostSaveInput, NoteWrites, RelatedChannel, RelatedNote } from '../../../src/modules/note/create-contract.js';

const author: NoteCreateAuthor = { id: 'author', host: null, isSuspended: false, movedToUri: null, isBot: false, canPublicNote: true, mentionLimit: 20, rateLimitFactor: 1, sensitiveWords: [], prohibitedWords: [] };
const actor = { userId: 'author', canWriteNote: true };
const ownedFiles: NoteAttachableFile[] = [{ id: 'img', type: 'image/png' }, { id: 'vid', type: 'video/mp4' }];
const now = 1_000_000;
const noRelations = {
	readNote: async () => null, isBlocking: async () => false, isFollowing: async () => false,
	readChannel: async () => null, readMentionedRemoteUsers: async () => [],
};

interface World {
	notes?: RelatedNote[];
	// [blocker, blockee]
	blockings?: [string, string][];
	// [follower, followee]
	followings?: [string, string][];
	channels?: (RelatedChannel & { isArchived?: boolean })[];
	remoteUsers?: (MentionedRemoteUser & { id: string })[];
}

function related(id: string, facts: Partial<RelatedNote> = {}): RelatedNote {
	return {
		id, userId: 'other', userHost: null, text: id, cw: null, fileIds: [], hasPoll: false, replyId: null, renoteId: null, threadId: null,
		channelId: null, visibility: 'public', visibleUserIds: [], mentions: [], replyUserId: null, localOnly: false, ...facts,
	};
}

function setup(facts: NoteCreateAuthor | null = author, options: { files?: NoteAttachableFile[]; failPoll?: boolean; failRender?: boolean; world?: World } = {}) {
	const world = options.world ?? {};
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
		readNote: async id => {
			events.push(`note:${id}`);
			return world.notes?.find(note => note.id === id) ?? null;
		},
		isBlocking: async (blocker, blockee) => {
			events.push(`blocking:${blocker}:${blockee}`);
			return world.blockings?.some(([a, b]) => a === blocker && b === blockee) ?? false;
		},
		isFollowing: async (follower, followee) => {
			events.push(`following:${follower}:${followee}`);
			return world.followings?.some(([a, b]) => a === follower && b === followee) ?? false;
		},
		readChannel: async (id, { includeArchived }) => {
			events.push(`channel:${id}:${includeArchived ? 'any' : 'active'}`);
			const channel = world.channels?.find(c => c.id === id && (includeArchived || !c.isArchived));
			return channel ? { id: channel.id, allowRenoteToExternal: channel.allowRenoteToExternal } : null;
		},
		readMentionedRemoteUsers: async ids => ids.flatMap(id => (world.remoteUsers ?? []).filter(user => user.id === id).map(({ id: _, ...user }) => user)),
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
	expect(notes).toEqual([{
		id: 'new', userId: 'author', userHost: null, text: 'hello', cw: null, visibility: 'public', localOnly: false, reactionAcceptance: null, channelId: null,
		fileIds: [], attachedFileTypes: [], hasPoll: false, replyId: null, renoteId: null, threadId: null, replyUserId: null, replyUserHost: null,
		renoteUserId: null, renoteUserHost: null, renoteChannelId: null, visibleUserIds: [], mentions: [], mentionedRemoteUsers: [],
	}]);
	expect(polls).toEqual([]);
	expect(after).toEqual([{ userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null }]);
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
		...noRelations, readOwnedFiles: async () => [], writes, transactions: { run: async <T>(work: (scope: NoteWrites) => Promise<T>) => work(writes) },
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
	const create = createCreateNote({ ...noRelations, readAuthor: async () => author, readOwnedFiles: async () => [], writes, transactions: { run: work => work(writes) }, afterSaved: () => {
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
	[{ text: 'forbidden', fileIds: ['img'], renoteId: 'x', poll: { choices: ['a', 'b'], expiresAt: 1 } }, 'NO_SUCH_RENOTE_TARGET'],
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

const relationWorld: World = {
	notes: [
		related('public'), related('home', { visibility: 'home' }), related('local', { localOnly: true }),
		related('followers', { visibility: 'followers' }), related('ownFollowers', { userId: 'author', visibility: 'followers' }),
		related('specified', { visibility: 'specified', visibleUserIds: ['author'] }), related('ownSpecified', { userId: 'author', visibility: 'specified' }),
		related('pure', { text: null, renoteId: 'public' }), related('quote', { text: null, renoteId: 'public', replyId: 'public' }),
		related('blocker', { userId: 'blocker' }), related('closed', { channelId: 'closedCh' }), related('open', { channelId: 'openCh' }),
		related('archivedNote', { channelId: 'archivedCh' }), related('orphan', { channelId: 'goneCh' }),
		related('nested', { replyId: 'public', threadId: 'root' }), related('remote', { userId: 'remoteUser', userHost: 'remote.test' }),
	],
	blockings: [['blocker', 'author'], ['author', 'other']],
	channels: [{ id: 'closedCh', allowRenoteToExternal: false }, { id: 'openCh', allowRenoteToExternal: true }, { id: 'archivedCh', allowRenoteToExternal: true, isArchived: true }],
	remoteUsers: [{ id: 'remoteUser', uri: 'https://remote.test/users/r', username: 'r', host: 'remote.test' }],
};

// 本家 NoteCreateService.ts:320-420。Renote 対象→返信先→投票期限→channel の順に、最初の誤りを返す。
test.each([
	[{ renoteId: 'missing', replyId: 'missing' }, 'NO_SUCH_RENOTE_TARGET'],
	[{ renoteId: 'pure', text: 'quote' }, 'CANNOT_RENOTE_TO_A_PURE_RENOTE'],
	[{ renoteId: 'blocker' }, 'YOU_HAVE_BEEN_BLOCKED'],
	[{ renoteId: 'blocker', text: 'quote' }, 'YOU_HAVE_BEEN_BLOCKED'],
	[{ renoteId: 'followers' }, 'CANNOT_RENOTE_DUE_TO_VISIBILITY'],
	[{ renoteId: 'ownSpecified' }, 'CANNOT_RENOTE_DUE_TO_VISIBILITY'],
	[{ renoteId: 'closed', text: 'quote' }, 'CANNOT_RENOTE_OUTSIDE_OF_CHANNEL'],
	[{ renoteId: 'closed', channelId: 'openCh' }, 'CANNOT_RENOTE_OUTSIDE_OF_CHANNEL'],
	[{ renoteId: 'orphan' }, 'NO_SUCH_CHANNEL'],
	[{ renoteId: 'public', replyId: 'missing' }, 'NO_SUCH_REPLY_TARGET'],
	[{ replyId: 'pure', text: 'x' }, 'CANNOT_REPLY_TO_A_PURE_RENOTE'],
	[{ replyId: 'followers', text: 'x' }, 'CANNOT_REPLY_TO_AN_INVISIBLE_NOTE'],
	[{ replyId: 'specified', text: 'x' }, 'CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY'],
	[{ replyId: 'blocker', text: 'x' }, 'YOU_HAVE_BEEN_BLOCKED'],
	[{ replyId: 'missing', text: 'x', poll: { choices: ['a', 'b'], expiresAt: 1 } }, 'NO_SUCH_REPLY_TARGET'],
	[{ text: 'x', poll: { choices: ['a', 'b'], expiresAt: 1 }, channelId: 'missing' }, 'CANNOT_CREATE_ALREADY_EXPIRED_POLL'],
	[{ text: 'forbidden', channelId: 'archivedCh' }, 'NO_SUCH_CHANNEL'],
	[{ replyId: 'public', text: 'x', channelId: 'missing' }, 'NO_SUCH_CHANNEL'],
] as const)('relation checks %j fail with %s before saving', async (input, code) => {
	const { createNote, notes } = setup({ ...author, prohibitedWords: ['forbidden'] }, { world: relationWorld });
	await expect(createNote(input)).rejects.toMatchObject({ code });
	expect(notes).toEqual([]);
});

// 本家 NoteEntityService.isVisibleForMe と NoteCreateService.ts:338-349。逆方向のブロックは見ない。
test.each([
	[{ replyId: 'followers', text: 'x' }, { followings: [['author', 'other']] }],
	[{ replyId: 'followers', text: 'x' }, { notes: [related('followers', { visibility: 'followers', mentions: ['author'] })] }],
	[{ replyId: 'ownFollowers', text: 'x' }, {}],
	[{ renoteId: 'ownFollowers' }, {}],
	[{ renoteId: 'public', replyId: 'public' }, { blockings: [['author', 'other']] }],
	[{ replyId: 'quote', text: 'x' }, {}],
] as const)('relation %j is accepted with %j', async (input, extra) => {
	const { createNote, notes } = setup(author, { world: { ...relationWorld, ...extra } as World });
	await createNote(input);
	expect(notes).toHaveLength(1);
});

// 本家 NoteCreateService.ts:449-570。channel の強制の後で Renote 対象→返信先の順に公開範囲を狭め、localOnly は channel なしのときだけ継承する。
test.each([
	[{ renoteId: 'home' }, { visibility: 'home', localOnly: false, channelId: null }],
	[{ renoteId: 'ownFollowers', visibility: 'home' }, { visibility: 'followers', localOnly: false, channelId: null }],
	[{ replyId: 'ownSpecified', text: 'x', visibility: 'specified' }, { visibility: 'specified', visibleUserIds: ['author'], mentions: [] }],
	[{ replyId: 'local', text: 'x' }, { localOnly: true }],
	[{ renoteId: 'local' }, { localOnly: true }],
	[{ renoteId: 'home', channelId: 'openCh', visibility: 'specified' }, { visibility: 'home', localOnly: true, channelId: 'openCh' }],
	[{ replyId: 'open', text: 'x', channelId: 'closedCh' }, { channelId: 'openCh', localOnly: true, visibility: 'public', threadId: 'open' }],
	[{ replyId: 'public', text: 'x', channelId: 'openCh' }, { channelId: null, localOnly: false }],
	[{ replyId: 'archivedNote', text: 'x' }, { channelId: 'archivedCh', localOnly: true }],
	[{ text: 'needle', channelId: 'openCh' }, { visibility: 'public', channelId: 'openCh' }],
	[{ renoteId: 'open' }, { channelId: null, localOnly: false, renoteChannelId: 'openCh' }],
	[{ renoteId: 'public', text: '   ' }, { text: null, renoteId: 'public', mentions: [] }],
	[{ replyId: 'nested', text: 'x' }, { threadId: 'root', replyUserId: 'other', mentions: ['other'] }],
	[{ text: 'x', visibleUserIds: ['someone'] }, { visibility: 'public', visibleUserIds: [] }],
	[{ text: 'x', visibility: 'specified', visibleUserIds: ['someone'], channelId: 'openCh' }, { visibility: 'public', visibleUserIds: [] }],
] as const)('input %j is corrected to %j', async (input, expected) => {
	const { createNote, notes } = setup({ ...author, sensitiveWords: ['needle'] }, { world: relationWorld });
	await createNote(input);
	expect(notes[0]).toMatchObject(expected);
});

test('a reply to a remote author stores the remote mention and denormalized reply and Renote columns', async () => {
	const { createNote, notes, polls } = setup(author, { world: relationWorld });
	await createNote({ replyId: 'remote', renoteId: 'open', channelId: 'openCh', poll: { choices: ['a', 'b'] } });
	expect(notes[0]).toMatchObject({
		replyId: 'remote', renoteId: 'open', threadId: 'remote', replyUserId: 'remoteUser', replyUserHost: 'remote.test', renoteUserId: 'other',
		renoteUserHost: null, renoteChannelId: 'openCh', channelId: null, mentions: ['remoteUser'],
		mentionedRemoteUsers: [{ uri: 'https://remote.test/users/r', username: 'r', host: 'remote.test' }],
	});
	expect(polls[0]).toMatchObject({ noteVisibility: 'public', channelId: null });
});

// 本家 NoteCreateService.ts:611-613,629-632: 返信先の作者もメンション数に数える。
test('the reply author counts toward the mention limit', async () => {
	const { createNote, notes } = setup({ ...author, mentionLimit: 0 }, { world: relationWorld });
	await expect(createNote({ replyId: 'public', text: 'x' })).rejects.toMatchObject({ code: 'CONTAINS_TOO_MANY_MENTIONS' });
	await createNote({ replyId: 'ownFollowers', text: 'x' });
	expect(notes).toHaveLength(1);
});

test('specified recipients stay unimplemented until they can be resolved', async () => {
	const { createNote, notes } = setup(author, { world: relationWorld });
	await expect(createNote({ text: 'x', visibility: 'specified', visibleUserIds: ['someone'] })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
	expect(notes).toEqual([]);
});

// 本家 NoteCreateService.ts:786-788,815-817,927-944。
test.each([
	[author, { replyId: 'public', renoteId: 'home', channelId: 'openCh' }, { repliedNoteId: 'public', renotedNoteId: 'home', channelId: null }],
	[author, { renoteId: 'ownFollowers' }, { repliedNoteId: null, renotedNoteId: null }],
	[{ ...author, isBot: true }, { renoteId: 'public' }, { renotedNoteId: null }],
	[{ ...author, isBot: true }, { replyId: 'public', text: 'x' }, { repliedNoteId: 'public' }],
	[author, { replyId: 'open', text: 'x' }, { repliedNoteId: 'open', channelId: 'openCh' }],
] as const)('post-save counts for %j and %j', async (facts, input, expected) => {
	const { createNote, after } = setup(facts, { world: relationWorld });
	await createNote(input);
	expect(after).toEqual([expect.objectContaining({ userId: 'author', ...expected })]);
});
