/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scopedEvidenceValidation } from './evidence-validation-scope.mjs';
const directory = 'docs/superpowers/compatibility/notes-pagination/';
const receiptSeal = 'a1cc05dfaa86eab26c661a39717fa5a49f0f68b6d75ccdd3f38a8f26aa5a0368';
const predecessorSeal = '3ecbc05f908b71d8e5750e70d8f3384fa7866ebaaeffda421d1bf3433c545e3a';
const historicalSeals = {"r1-current-evidence.json": "ffc91999009233ae9da8b05c589ca08854dc249f6e7d8647eff5acc1ea84312a", "r1-predecessor.json": "51074136dcd387e79ce49cb38079d7363a240caf03c50d6da237e6e6de838808", "r2-current-evidence.json": "7f0c730a8ef247ff244f5994150ece5c61671492734537b8805f134d86937aee"};
const projection = {
  "packages/backend-next/src/composition/note-routes.ts": {
    "currentSha256": "ccac3cb13d5dbe5908f869cd1de788fff20ba877e00f722ec25f47507fca76e0",
    "previousSha256": "13b7a773654f30a3ebd81c2d1797148ecfe16f77c42247ad5390af4062ac9122",
    "patches": [
      {
        "offset": 442,
        "insert": "sListApi } from '../http/notes-list-api.js';\nimport { createListNotes } from '../modules/note/public.js';\nimport { createNotesListReader } from '../platform/database/note-list.js';\nimport { createNoteCreateApi } from '../http/note-create-api.js';\nimport { createNoteRateLimiter } from '../platform/note-rate-limit.js';\nimport { createDeleteNote, createShowNote, readNotePlan, renderNote } from '../modules/note/public.js';\nimport { createHostRules, renderDeletedNoteActivity } from '../modules/federation/public.js';\nimport { createNoteReader } from '../platform/database/note-reader.js';\nimport { createTokenAuthenticator } from '../platform/database/authenticate.js';\nimport { createIdCodec } from '../platform/id-codec.js';\nimport { createNoteApplication } from './note.js';\nimport { createRemoteUsers } from './remote-users.js';\nimport type { RuntimeResources } from './create-runtime.js';\nimport type { RuntimeConfig } from '../config/types.js';\nimport type { Hono } from 'hono';\n\nexport function prepareNoteRoutes(resources: RuntimeResources, config: RuntimeConfig) {\n\tconst manager = resources.dataSource.manager;\n\tconst codec = createIdCodec(config.id);\n\tconst reader = createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis);\n\tconst show = createShowNote(reader);\n\tconst list = createListNotes(createNotesListReader(manager, resources.reactionsRedis,\n\t\t{ ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis), codec.newId);\n\tconst create = createNoteApplication({\n\t\tdataSource: resources.dataSource, roleMaterials: resources.roleMaterials, ids: codec, clock: Date.now,\n\t\tremoteUsers: createRemoteUsers(resources, config),\n\t\tlimit: createNoteRateLimiter(resources.redis),\n\t\tafterSaved: input => resources.notePostSave.start(input),\n\t});\n\tconst deletion = createDeleteNote({\n\t\t...createNoteDeleter(manager, codec.createdAtFromId),\n\t\tlimit: createNoteDeleteRateLimiter(resources.redis),\n\t\trenderActivity: (snapshot, now) => renderDeletedNoteActivity(snapshot, {\n\t\t\tselfUrl: config.url, now, randomId: randomUUID(), isLocalUri: createHostRules(new URL(config.url).host).isUriLocal,\n\t\t}),\n\t\tstart: resources.notePostDelete.start,\n\t\tpublishDeleted: (snapshot, occurredAtMs) => resources.notePostDelete.start({ kind: 'stream', snapshot, occurredAtMs }),\n\t});\n\tconst authenticate = createTokenAuthenticator(manager, resources.logger);\n\treturn { authenticate, deletion, show, list, create, reader };\n}\n\nexport function registerNoteRoutes(app: Hono, resources: RuntimeResources, prepared: ReturnType<typeof prepareNoteRoutes>) {\n\tconst { authenticate, deletion, show, list, create, reader } = prepared;\n\treturn app\n\t\t.route('/', createNotesListApi({ authenticate, listNotes: list.listNotes, logger: resources.logger }))",
        "previous": "CreateApi } from '../http/note-create-api.js';\nimport { createNoteRateLimiter } from '../platform/note-rate-limit.js';\nimport { createDeleteNote, createShowNote, readNotePlan, renderNote } from '../modules/note/public.js';\nimport { createHostRules, renderDeletedNoteActivity } from '../modules/federation/public.js';\nimport { createNoteReader } from '../platform/database/note-reader.js';\nimport { createTokenAuthenticator } from '../platform/database/authenticate.js';\nimport { createIdCodec } from '../platform/id-codec.js';\nimport { createNoteApplication } from './note.js';\nimport { createRemoteUsers } from './remote-users.js';\nimport type { RuntimeResources } from './create-runtime.js';\nimport type { RuntimeConfig } from '../config/types.js';\nimport type { Hono } from 'hono';\n\nexport function prepareNoteRoutes(resources: RuntimeResources, config: RuntimeConfig) {\n\tconst manager = resources.dataSource.manager;\n\tconst codec = createIdCodec(config.id);\n\tconst reader = createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis);\n\tconst show = createShowNote(reader);\n\tconst create = createNoteApplication({\n\t\tdataSource: resources.dataSource, roleMaterials: resources.roleMaterials, ids: codec, clock: Date.now,\n\t\tremoteUsers: createRemoteUsers(resources, config),\n\t\tlimit: createNoteRateLimiter(resources.redis),\n\t\tafterSaved: input => resources.notePostSave.start(input),\n\t});\n\tconst deletion = createDeleteNote({\n\t\t...createNoteDeleter(manager, codec.createdAtFromId),\n\t\tlimit: createNoteDeleteRateLimiter(resources.redis),\n\t\trenderActivity: (snapshot, now) => renderDeletedNoteActivity(snapshot, {\n\t\t\tselfUrl: config.url, now, randomId: randomUUID(), isLocalUri: createHostRules(new URL(config.url).host).isUriLocal,\n\t\t}),\n\t\tstart: resources.notePostDelete.start,\n\t\tpublishDeleted: (snapshot, occurredAtMs) => resources.notePostDelete.start({ kind: 'stream', snapshot, occurredAtMs }),\n\t});\n\tconst authenticate = createTokenAuthenticator(manager, resources.logger);\n\treturn { authenticate, deletion, show, create, reader };\n}\n\nexport function registerNoteRoutes(app: Hono, resources: RuntimeResources, prepared: ReturnType<typeof prepareNoteRoutes>) {\n\tconst { authenticate, deletion, show, create, reader } = prepared;\n\treturn app"
      }
    ]
  },
  "packages/backend-next/src/modules/note/public.ts": {
    "currentSha256": "e2a810519faf1d6ec025d7f7817776a86795c6e07bbfdbddcc120e8203a507f1",
    "previousSha256": "6ba915caac0c26b9be0a2679b548eb5966492ce4a39333d7d9b8ed7f83f930cd",
    "patches": [
      {
        "offset": 176,
        "insert": "createListNotes } from './list-notes.js';\nexport type { NotesListInput, NotesListReader } from './list-notes.js';\nexport { ",
        "previous": ""
      }
    ]
  },
  "packages/backend-next/src/platform/database/note-reader.ts": {
    "currentSha256": "989af51a138f31ea6b5075bb18abb4ce9221ad92d33cf7a8b1de88b8de8fce9e",
    "previousSha256": "3e68faa46639ae6de3997454ae404036b2583e5edfbca94d8a2244b8ffc709d2",
    "patches": [
      {
        "offset": 969,
        "insert": ", selectedUsers: readonly MiUser[] = [], refreshUserIds: readonly string[] = []): NoteFactsReader {\n\treturn {\n\t\tasync readNotes(ids) {\n\t\t\tif (ids.length === 0) {\n\t\t\t\treturn [];\n\t\t\t}\n\t\t\treturn (await manager.getRepository(MiNote).findBy({ id: In([...ids]) })).map(row => noteFactsFromRow(row, options.createdAtFromId));\n\t\t},\n\t\tasync readGuestAccess(note) {\n\t\t\tconst author = await manager.getRepository(MiUser).findOneByOrFail({ id: note.userId });\n\t\t\tconst meta = await readMeta(manager);\n\t\t\treturn { authorRequiresSignin: author.requireSigninToViewContents, ugcVisibilityForVisitor: meta.ugcVisibilityForVisitor };\n\t\t},\n\t\tasync readMaterials(notes, viewerId, now): Promise<NoteViewMaterials> {\n\t\t\tconst rows = [...notes.values()];\n\t\t\tconst ids = [...notes.keys()];\n\t\t\tconst userIds = [...new Set(rows.map(n => n.userId))];\n\t\t\tconst fileIds = [...new Set(rows.flatMap(n => n.fileIds))];\n\t\t\tconst channelIds = [...new Set(rows.flatMap(n => n.channelId ? [n.channelId] : []))];\n\t\t\tconst pollIds = rows.filter(n => n.hasPoll).map(n => n.id);\n\t\t\tconst meta = await readMeta(manager);\n\t\t\tconst buffered = new Map<string, { deltas: Record<string, number>; pairs: string[] }>();\n\t\t\tif (meta.enableReactionsBuffering && ids.length > 0) {\n\t\t\t\tconst pipeline = redis.pipeline();\n\t\t\t\tfor (const id of ids) {\n\t\t\t\t\tpipeline.hgetall(`reactionsBufferDeltas:${id}`).zrange(`reactionsBufferPairs:${id}`, 0, -1);\n\t\t\t\t}\n\t\t\t\tconst result = await pipeline.exec();\n\t\t\t\tif (!result || result.some(([error]) => error !== null)) {\n\t\t\t\t\tthrow new Error('NOTE_REACTIONS_UNAVAILABLE');\n\t\t\t\t}\n\t\t\t\tfor (const [index, id] of ids.entries()) {\n\t\t\t\t\tbuffered.set(id, { deltas: Object.fromEntries(Object.entries(result[index * 2][1] as Record<string, string>).map(([k, v]) => [k, parseInt(v, 10)])), pairs: result[index * 2 + 1][1] as string[] });\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst [files, channels, polls, votes, reactions, followings] = await settleAll([\n\t\t\t\tfileIds.length ? manager.getRepository(MiDriveFile).findBy({ id: In(fileIds) }) : [],\n\t\t\t\tchannelIds.length ? manager.getRepository(MiChannel).findBy({ id: In(channelIds) }) : [],\n\t\t\t\tpollIds.length ? manager.getRepository(MiPoll).findBy({ noteId: In(pollIds) }) : [],\n\t\t\t\tviewerId && pollIds.length ? manager.getRepository(MiPollVote).findBy({ noteId: In(pollIds), userId: viewerId }) : [],\n\t\t\t\tviewerId && ids.length ? manager.getRepository(MiNoteReaction).findBy({ noteId: In(ids), userId: viewerId }) : [],\n\t\t\t\tviewerId && userIds.length ? manager.getRepository(MiFollowing).findBy({ followeeId: In(userIds), followerId: viewerId }) : [],\n\t\t\t]);\n\t\t\t// 作者の絵文字材料も全authorを集めて一度に取得する。\n\t\t\tconst selected = new Map(selectedUsers.map(user => [user.id, user]));\n\t\t\tconst missingUsers = userIds.filter(id => !selected.has(id) || refreshUserIds.includes(id));\n\t\t\tconst emojiUsers = [...new Map([...selectedUsers.filter(user => userIds.includes(user.id)), ...(missingUsers.length ? await manager.getRepository(MiUser).find({ where: { id: In(missingUsers) }, select: { id: true, host: true, emojis: true } }) : [])].map(user => [user.id, user])).values()];\n\t\t\tconst emojiNames = new Set<string>();\n\t\t\tconst hosts = [...new Set([...rows.flatMap(n => n.userHost ? [n.userHost] : []), ...emojiUsers.flatMap(u => u.host ? [u.host] : [])])];\n\t\t\tfor (const name of [...rows.flatMap(n => [...n.emojis, ...Object.keys(n.reactions)]), ...[...buffered.values()].flatMap(b => Object.keys(b.deltas)), ...(actorEmojis ? [] : emojiUsers.flatMap(u => u.emojis))]) {\n\t\t\t\tconst bareName = name.replace(/^:/, '').replace(/:$/, '');\n\t\t\t\temojiNames.add(bareName.split('@')[0]);\n\t\t\t\tconst match = name.match(/@([\\w.-]+):?$/);\n\t\t\t\tif (match && match[1] !== '.') {\n\t\t\t\t\tconst host = toPuny(match[1]);\n\t\t\t\t\tif (host) {\n\t\t\t\t\t\thosts.push(host);\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst emojiUrls = new Map((hosts.length && emojiNames.size ? await manager.getRepository(MiEmoji).findBy({ host: In([...new Set(hosts)]), name: In([...emojiNames]) }) : []).map(e => [`${e.name}@${e.host}`, e.publicUrl || e.originalUrl]));\n\t\t\tconst authorEmojiUrls = actorEmojis ? await actorEmojis.remote(emojiUsers, new URL(options.url).host) : emojiUrls;\n\t\t\treturn {\n\t\t\t\tnotes, authors: await readNoteAuthors(manager, userIds, viewerId, meta, options, now, authorEmojiUrls, actorEmojis !== undefined, selectedUsers, refreshUserIds",
        "previous": "): NoteFactsReader {\n\treturn {\n\t\tasync readNotes(ids) {\n\t\t\tif (ids.length === 0) {\n\t\t\t\treturn [];\n\t\t\t}\n\t\t\treturn (await manager.getRepository(MiNote).findBy({ id: In([...ids]) })).map(row => noteFactsFromRow(row, options.createdAtFromId));\n\t\t},\n\t\tasync readGuestAccess(note) {\n\t\t\tconst author = await manager.getRepository(MiUser).findOneByOrFail({ id: note.userId });\n\t\t\tconst meta = await readMeta(manager);\n\t\t\treturn { authorRequiresSignin: author.requireSigninToViewContents, ugcVisibilityForVisitor: meta.ugcVisibilityForVisitor };\n\t\t},\n\t\tasync readMaterials(notes, viewerId, now): Promise<NoteViewMaterials> {\n\t\t\tconst rows = [...notes.values()];\n\t\t\tconst ids = [...notes.keys()];\n\t\t\tconst userIds = [...new Set(rows.map(n => n.userId))];\n\t\t\tconst fileIds = [...new Set(rows.flatMap(n => n.fileIds))];\n\t\t\tconst channelIds = [...new Set(rows.flatMap(n => n.channelId ? [n.channelId] : []))];\n\t\t\tconst pollIds = rows.filter(n => n.hasPoll).map(n => n.id);\n\t\t\tconst meta = await readMeta(manager);\n\t\t\tconst buffered = new Map<string, { deltas: Record<string, number>; pairs: string[] }>();\n\t\t\tif (meta.enableReactionsBuffering && ids.length > 0) {\n\t\t\t\tconst pipeline = redis.pipeline();\n\t\t\t\tfor (const id of ids) {\n\t\t\t\t\tpipeline.hgetall(`reactionsBufferDeltas:${id}`).zrange(`reactionsBufferPairs:${id}`, 0, -1);\n\t\t\t\t}\n\t\t\t\tconst result = await pipeline.exec();\n\t\t\t\tif (!result || result.some(([error]) => error !== null)) {\n\t\t\t\t\tthrow new Error('NOTE_REACTIONS_UNAVAILABLE');\n\t\t\t\t}\n\t\t\t\tfor (const [index, id] of ids.entries()) {\n\t\t\t\t\tbuffered.set(id, { deltas: Object.fromEntries(Object.entries(result[index * 2][1] as Record<string, string>).map(([k, v]) => [k, parseInt(v, 10)])), pairs: result[index * 2 + 1][1] as string[] });\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst [files, channels, polls, votes, reactions, followings] = await settleAll([\n\t\t\t\tfileIds.length ? manager.getRepository(MiDriveFile).findBy({ id: In(fileIds) }) : [],\n\t\t\t\tchannelIds.length ? manager.getRepository(MiChannel).findBy({ id: In(channelIds) }) : [],\n\t\t\t\tpollIds.length ? manager.getRepository(MiPoll).findBy({ noteId: In(pollIds) }) : [],\n\t\t\t\tviewerId && pollIds.length ? manager.getRepository(MiPollVote).findBy({ noteId: In(pollIds), userId: viewerId }) : [],\n\t\t\t\tviewerId && ids.length ? manager.getRepository(MiNoteReaction).findBy({ noteId: In(ids), userId: viewerId }) : [],\n\t\t\t\tviewerId && userIds.length ? manager.getRepository(MiFollowing).findBy({ followeeId: In(userIds), followerId: viewerId }) : [],\n\t\t\t]);\n\t\t\t// 作者の絵文字材料も全authorを集めて一度に取得する。\n\t\t\tconst emojiUsers = userIds.length ? await manager.getRepository(MiUser).find({ where: { id: In(userIds) }, select: { id: true, host: true, emojis: true } }) : [];\n\t\t\tconst emojiNames = new Set<string>();\n\t\t\tconst hosts = [...new Set([...rows.flatMap(n => n.userHost ? [n.userHost] : []), ...emojiUsers.flatMap(u => u.host ? [u.host] : [])])];\n\t\t\tfor (const name of [...rows.flatMap(n => [...n.emojis, ...Object.keys(n.reactions)]), ...[...buffered.values()].flatMap(b => Object.keys(b.deltas)), ...(actorEmojis ? [] : emojiUsers.flatMap(u => u.emojis))]) {\n\t\t\t\tconst bareName = name.replace(/^:/, '').replace(/:$/, '');\n\t\t\t\temojiNames.add(bareName.split('@')[0]);\n\t\t\t\tconst match = name.match(/@([\\w.-]+):?$/);\n\t\t\t\tif (match && match[1] !== '.') {\n\t\t\t\t\tconst host = toPuny(match[1]);\n\t\t\t\t\tif (host) {\n\t\t\t\t\t\thosts.push(host);\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst emojiUrls = new Map((hosts.length && emojiNames.size ? await manager.getRepository(MiEmoji).findBy({ host: In([...new Set(hosts)]), name: In([...emojiNames]) }) : []).map(e => [`${e.name}@${e.host}`, e.publicUrl || e.originalUrl]));\n\t\t\tconst authorEmojiUrls = actorEmojis ? await actorEmojis.remote(emojiUsers, new URL(options.url).host) : emojiUrls;\n\t\t\treturn {\n\t\t\t\tnotes, authors: await readNoteAuthors(manager, userIds, viewerId, meta, options, now, authorEmojiUrls, actorEmojis !== undefined"
      }
    ]
  },
  "packages/backend-next/src/platform/database/note-authors.ts": {
    "currentSha256": "7137f07fbd9eb92b6fbbfabd2343ee79d28adf72d051ecc393c525d74211f668",
    "previousSha256": "a8161e9a9ae8fb6f595469cd52ff62cf5d613abb94bfc741143ca3fe4e082a17",
    "patches": [
      {
        "offset": 926,
        "insert": ", selectedUsers: readonly MiUser[] = [], refreshUserIds: readonly string[] = []) {\n\tconst userIds = [...new Set([...ids, ...(viewerId ? [viewerId] : [])])];\n\tconst selected = new Map(selectedUsers.map(user => [user.id, user]));\n\tconst missing = userIds.filter(id => !selected.has(id) || refreshUserIds.includes(id));\n\tconst users = [...new Map([...selectedUsers.filter(user => userIds.includes(user.id)), ...(missing.length ? await manager.getRepository(MiUser).findBy({ id: In(missing) }) : [])].map(user => [user.id, user])).values()]",
        "previous": ") {\n\tconst userIds = [...new Set([...ids, ...(viewerId ? [viewerId] : [])])];\n\tconst users = await manager.getRepository(MiUser).findBy({ id: In(userIds) })"
      }
    ]
  },
  "packages/backend-next/test/unit/composition/http-app.test.ts": {
    "currentSha256": "a2f030dbfecfa3644a09d1d1aca81a8693ffec7dbad1bc3ceac9894fb46be5eb",
    "previousSha256": "742be594f57ff832ccc0568b06720f9677d4a1519d0a6f17b88e24a19e6f9e49",
    "patches": [
      {
        "offset": 3004,
        "insert": "', '/api/notes",
        "previous": ""
      }
    ]
  }
};
const pollRecommendationProjection = {
  "packages/backend-next/src/composition/note-routes.ts": {
    "currentSha256": "2f7242d5d7b5ffcaf03a505c1ceabc2fedb1588bf88b49a1bc4ddbdf77e11b2a",
    "previousSha256": "ccac3cb13d5dbe5908f869cd1de788fff20ba877e00f722ec25f47507fca76e0",
    "patches": [
      {
        "offset": 142,
        "insert": "';\nimport { createPollRecommendationHttp } from './poll-recommendation-http.js",
        "previous": ""
      },
      {
        "offset": 3066,
        "insert": ", pollRecommendation: createPollRecommendationHttp(resources, config)",
        "previous": ""
      },
      {
        "offset": 3352,
        "insert": "\n\t\t.route('/', prepared.pollRecommendation)",
        "previous": ""
      }
    ]
  },
  "packages/backend-next/test/unit/composition/http-app.test.ts": {
    "currentSha256": "fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e",
    "previousSha256": "a2f030dbfecfa3644a09d1d1aca81a8693ffec7dbad1bc3ceac9894fb46be5eb",
    "patches": [
      {
        "offset": 3004,
        "insert": "/polls/recommendation', '/api/notes",
        "previous": ""
      },
      {
        "offset": 3148,
        "insert": "'notes/polls/recommendation', ",
        "previous": ""
      }
    ]
  }
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const optionalRead = path => {
	try {
		return readFileSync(path);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
export const notesPaginationPredecessorFiles = Object.freeze([
	'packages/backend-next/src/composition/note-routes.ts',
	'packages/backend-next/src/modules/note/public.ts',
	'packages/backend-next/src/platform/database/note-reader.ts',
	'packages/backend-next/src/platform/database/note-authors.ts',
	'packages/backend-next/test/unit/composition/http-app.test.ts',
]);

export function validateNotesPaginationEvidence(value, rawRead = read, optional = optionalRead) {
	return scopedEvidenceValidation(validateNotesPaginationEvidence, value, rawRead, optional, (rawRead, optional) => {
		const currentRead = rawRead;
		rawRead = path => projectPollRecommendationInput(path, projectUserMemoInput(path, currentRead(path)));
		for (const [name, digest] of Object.entries(historicalSeals)) assert.equal(sha(rawRead(directory + name)), digest, 'notes pagination historical receipt seal');
		const receipt = rawRead(directory + 'current-evidence.json');
		assert.equal(sha(receipt), receiptSeal, 'notes pagination receipt seal');
		value ??= JSON.parse(receipt);
		assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), receiptSeal, 'notes pagination receipt seal');
		assert.equal(value.scope, 'notes-pagination-305');
		assert.equal(value.baseRevision, '2fb256cd889200912cf68258e757f5e39429e495');
		assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
		assert.equal(value.measurement, 'R3');
		assert.equal(value.measuredWorkingTree, true);
		assert.equal(value.noInputDrift, true);
		assert.equal(value.postingComplete, false);
		assert.equal(value.upstreamFullServerMeasured, false);
		assert.deepEqual(value.inputsAfter, value.inputs);
		assert.equal(Object.keys(value.inputs).length, 15);
		for (const [path, digest] of Object.entries(value.inputs)) {
			assert.equal(sha(rawRead(path)), digest, `measured current input drift (notes pagination): ${path}`);
		}
		const bytes = rawRead(directory + 'predecessor.json');
		assert.equal(sha(bytes), predecessorSeal, 'notes pagination predecessor seal');
		const previous = JSON.parse(bytes);
		assert.equal(previous.baseRevision, value.baseRevision);
		assert.deepEqual(Object.keys(previous.files), notesPaginationPredecessorFiles);
		assert.deepEqual(previous.files, projection, 'notes pagination finite follow-up constants match the R2 record');
		const result = {};
		for (const [path, binding] of Object.entries(previous.files)) {
			assert.equal(binding.currentSha256, value.inputs[path]);
			let before = Buffer.from(rawRead(path));
			assert.equal(sha(before), binding.currentSha256, `measured current input drift (notes pagination): ${path}`);
			for (const patch of [...binding.patches].reverse()) {
				const insert = Buffer.from(patch.insert);
				assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'notes pagination exact predecessor anchor');
				before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
			}
			assert.equal(sha(before), binding.previousSha256, 'notes pagination exact predecessor identity');
			result[path] = before.toString();
		}
		assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'source']);
		for (const run of value.runs) {
			assert.equal(run.exitCode, 0);
			const log = optional(run.log);
			if (log !== null) {
				assert.equal(sha(log), run.logSha256, 'notes pagination actual log drift');
				if (run.passed !== undefined) assert(log.toString().includes(`Tests  ${run.passed} passed (${run.passed})`), 'notes pagination actual test count');
			}
		}
		return result;
	});
}

// Historical leaves consume only these exact five byte transitions. The full
// notes measurement is checked independently by notes-pagination-contract.test.mjs.
export function projectNotesPaginationInput(path, actual) {
	actual = projectPollRecommendationInput(path, projectUserMemoInput(path, actual));
	const binding = Object.hasOwn(projection, path) ? projection[path] : undefined;
	if (!binding) return actual;
	assert.equal(sha(actual), binding.currentSha256, `measured current input drift (notes pagination): ${path}`);
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const insert = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'notes pagination exact predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'notes pagination exact predecessor identity');
	return before;
}

// #294 adds only a memo route and its registration assertion. Preserve the
// earlier measurements; the optional #489 combination removes only #294 bytes.
const userMemoProjection = {
	'packages/backend-next/src/composition/http-app.ts': {
		relationCurrent: '5f881c86b179744c73be9d1c7b668a2227747b9cf98a8a7ecfbb7b2dc2b68264',
		relationPrevious: '70ad0cbb84ddcefaa2e6fc9ac79e1a0c769707537ed39d200d7340b98c0657a6',
		relationAdditions: ["import { createUserRelationHttp } from './user-relation-http.js';\n", "\t\t.route('/', createUserRelationHttp(resources))\n"],
		current: '70ad0cbb84ddcefaa2e6fc9ac79e1a0c769707537ed39d200d7340b98c0657a6',
		previous: 'e8851b4ec5bba14758c315e98368105051463cb7cba8d26b3c18ad332ff381cc',
		additions: ["import { createUserMemoHttp } from './user-memo-http.js';\n", "\t\t.route('/', createUserMemoHttp(resources, config))\n"],
	},
	'packages/backend-next/test/unit/composition/http-app.test.ts': {
		relationCurrent: '734cee44fd1181a8c77fa08bf05623e41b28478b0f4eea8a2d2f8689c7632899',
		relationPrevious: 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2',
		relationAdditions: [", '/api/users/relation'"],
		current: '43aab6cd144b8d0937fca5bec41322d2bed0125c1f94118e7bebb4437d901bda',
		previous: 'a2f030dbfecfa3644a09d1d1aca81a8693ffec7dbad1bc3ceac9894fb46be5eb',
		combined: 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2',
		pollOnly: 'fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e',
		additions: ["\t\t'/api/users/update-memo',\n"],
	},
};

export function projectUserMemoInput(path, actual) {
	actual = projectPageReadInput(path, actual);
	const binding = Object.hasOwn(userMemoProjection, path) ? userMemoProjection[path] : undefined;
	if (!binding) return actual;
	if (sha(actual) === binding.relationCurrent) {
		let before = actual.toString();
		for (const addition of binding.relationAdditions) {
			assert.equal(before.split(addition).length, 2, 'relation exact predecessor anchor');
			before = before.replace(addition, '');
		}
		assert.equal(sha(before), binding.relationPrevious, 'relation exact predecessor identity');
		actual = Buffer.from(before);
	}
	const digest = sha(actual);
	if (digest === binding.previous || digest === binding.pollOnly) return actual;
	const driftLabel = path.endsWith('/src/composition/http-app.ts') ? 'Meta cache measured current input drift' : 'measured current input drift (notes pagination)';
	assert(digest === binding.current || (binding.combined && digest === binding.combined), `${driftLabel}: ${path} (user memo predecessor)`);
	let before = actual.toString();
	for (const addition of binding.additions) {
		assert.equal(before.split(addition).length, 2, 'user memo exact predecessor anchor');
		before = before.replace(addition, '');
	}
	assert.equal(sha(before), digest === binding.combined ? binding.pollOnly : binding.previous, 'user memo exact predecessor identity');
	return Buffer.from(before);
}

// Only these measured #489 additions project to the immutable #305 R3 input.
export function projectPollRecommendationInput(path, actual) {
	const binding = Object.hasOwn(pollRecommendationProjection, path) ? pollRecommendationProjection[path] : undefined;
	if (!binding) return actual;
	assert.equal(sha(actual), binding.currentSha256, `measured current input drift (notes pagination): ${path} (poll recommendation)`);
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const insert = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'poll recommendation exact predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'poll recommendation exact predecessor identity');
	return before;
}

// Page-only and the exact Page+Relation combination restore the previous
// shared input; the combined branch retains Relation for its existing step.
const pageReadProjection = {
  "packages/backend-next/src/composition/http-app.ts": {
    "current": "2e8d012d59c1c0ca2920eefccc7a542ab73de8a15dc82a211d3ab0a49beabe26",
    "previous": "70ad0cbb84ddcefaa2e6fc9ac79e1a0c769707537ed39d200d7340b98c0657a6",
    "patches": [
      {
        "offset": 313,
        "insert": "-http.js';\nimport { createPagesHttp } from './pages",
        "previous": ""
      },
      {
        "offset": 1712,
        "insert": "pages = createPagesHttp(resources, config);\n\tconst ",
        "previous": ""
      },
      {
        "offset": 1970,
        "insert": ")\n\t\t.route('/', pages.app",
        "previous": ""
      },
      {
        "offset": 2673,
        "insert": "async () => {\n\t\tawait Promise.all([",
        "previous": ""
      },
      {
        "offset": 2720,
        "insert": "(), pages.idle()]);\n\t}",
        "previous": ""
      }
    ],
    "relationCurrent": "5f881c86b179744c73be9d1c7b668a2227747b9cf98a8a7ecfbb7b2dc2b68264",
    "combinedCurrent": "350bbc6ff8951287282253c391a80d9be2c1d4d6fbd5dce6149b51c00c3f386f",
    "combinedPatches": [
      {
        "offset": 379,
        "insert": "-http.js';\nimport { createPagesHttp } from './pages",
        "previous": ""
      },
      {
        "offset": 1778,
        "insert": "pages = createPagesHttp(resources, config);\n\tconst ",
        "previous": ""
      },
      {
        "offset": 2085,
        "insert": ")\n\t\t.route('/', pages.app",
        "previous": ""
      },
      {
        "offset": 2788,
        "insert": "async () => {\n\t\tawait Promise.all([",
        "previous": ""
      },
      {
        "offset": 2835,
        "insert": "(), pages.idle()]);\n\t}",
        "previous": ""
      }
    ]
  },
  "packages/backend-next/test/unit/composition/http-app.test.ts": {
    "current": "f6e205b59d56cd23cd835ec57e80f0fafbedc708a75284cd0af5f1c8bddb4e8f",
    "previous": "cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2",
    "patches": [
      {
        "offset": 2271,
        "insert": "', '/api/pages/show",
        "previous": ""
      }
    ],
    "relationCurrent": "734cee44fd1181a8c77fa08bf05623e41b28478b0f4eea8a2d2f8689c7632899",
    "combinedCurrent": "f107b9b110e85b050fb1ff3d2ce92d6b3cf973911fcf43bea0c4b805f63a765b",
    "combinedPatches": [
      {
        "offset": 2294,
        "insert": "', '/api/pages/show",
        "previous": ""
      }
    ]
  }
};
export function projectPageReadInput(path, actual) {
	const binding = Object.hasOwn(pageReadProjection, path) ? pageReadProjection[path] : undefined;
	if (!binding) return actual;
	const digest = sha(actual);
	if ([binding.previous, binding.relationCurrent, userMemoProjection[path]?.previous, userMemoProjection[path]?.pollOnly].includes(digest)) return actual;
	const combined = digest === binding.combinedCurrent;
	const driftLabel = path.endsWith('/src/composition/http-app.ts') ? 'Meta cache measured current input drift' : 'measured current input drift (notes pagination)';
	assert(digest === binding.current || combined, `${driftLabel}: ${path} (Page/Relation read)`);
	let before = Buffer.from(actual);
	for (const patch of [...(combined ? binding.combinedPatches : binding.patches)].reverse()) {
		const insert = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'Page read exact predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
	}
	assert.equal(sha(before), combined ? binding.relationCurrent : binding.previous, 'Page read exact predecessor identity');
	return before;
}
