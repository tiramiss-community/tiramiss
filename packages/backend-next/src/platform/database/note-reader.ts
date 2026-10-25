/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { domainToASCII } from 'node:url';
import { In } from 'typeorm';
import { MiNote, MiUser, MiMeta, MiPoll, MiPollVote, MiNoteReaction, MiFollowing, MiDriveFile, MiChannel, MiEmoji } from 'backend-upstream/entities';
import { readNoteAuthors } from './note-authors.js';
import { noteFileView } from './note-files.js';
import type { NoteMediaOptions } from './note-files.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import type { NoteFacts, NoteFactsReader, NoteViewMaterials } from '../../modules/note/public.js';

export function createNoteReader(manager: EntityManager, redis: Redis, options: NoteMediaOptions): NoteFactsReader {
	return {
		async readNotes(ids) {
			if (ids.length === 0) {
				return [];
			}
			return (await manager.getRepository(MiNote).findBy({ id: In([...ids]) })).map((row): NoteFacts => ({
				id: row.id, createdAtMs: options.createdAtFromId(row.id), userId: row.userId, userHost: row.userHost,
				text: row.text, name: row.name, cw: row.cw, visibility: row.visibility, localOnly: row.localOnly,
				reactionAcceptance: row.reactionAcceptance, visibleUserIds: row.visibleUserIds, mentions: row.mentions,
				tags: row.tags, emojis: row.emojis, fileIds: row.fileIds, replyId: row.replyId, replyUserId: row.replyUserId,
				renoteId: row.renoteId, channelId: row.channelId, renoteCount: row.renoteCount, repliesCount: row.repliesCount,
				clippedCount: row.clippedCount, reactions: row.reactions, reactionPairs: row.reactionAndUserPairCache,
				hasPoll: row.hasPoll, uri: row.uri, url: row.url,
			}));
		},
		async readGuestAccess(note) {
			const author = await manager.getRepository(MiUser).findOneByOrFail({ id: note.userId });
			const meta = await manager.getRepository(MiMeta).findOneByOrFail({});
			return { authorRequiresSignin: author.requireSigninToViewContents, ugcVisibilityForVisitor: meta.ugcVisibilityForVisitor };
		},
		async readMaterials(notes, viewerId, now): Promise<NoteViewMaterials> {
			const rows = [...notes.values()];
			const ids = [...notes.keys()];
			const userIds = [...new Set(rows.map(n => n.userId))];
			const fileIds = [...new Set(rows.flatMap(n => n.fileIds))];
			const channelIds = [...new Set(rows.flatMap(n => n.channelId ? [n.channelId] : []))];
			const pollIds = rows.filter(n => n.hasPoll).map(n => n.id);
			const meta = await manager.getRepository(MiMeta).findOneByOrFail({});
			const buffered = new Map<string, { deltas: Record<string, number>; pairs: string[] }>();
			if (meta.enableReactionsBuffering && ids.length > 0) {
				const pipeline = redis.pipeline();
				for (const id of ids) {
					pipeline.hgetall(`reactionsBufferDeltas:${id}`).zrange(`reactionsBufferPairs:${id}`, 0, -1);
				}
				const result = await pipeline.exec();
				if (!result || result.some(([error]) => error !== null)) {
					throw new Error('NOTE_REACTIONS_UNAVAILABLE');
				}
				for (const [index, id] of ids.entries()) {
					buffered.set(id, { deltas: Object.fromEntries(Object.entries(result[index * 2][1] as Record<string, string>).map(([k, v]) => [k, parseInt(v, 10)])), pairs: result[index * 2 + 1][1] as string[] });
				}
			}
			const [files, channels, polls, votes, reactions, followings] = await Promise.all([
				fileIds.length ? manager.getRepository(MiDriveFile).findBy({ id: In(fileIds) }) : [],
				channelIds.length ? manager.getRepository(MiChannel).findBy({ id: In(channelIds) }) : [],
				pollIds.length ? manager.getRepository(MiPoll).findBy({ noteId: In(pollIds) }) : [],
				viewerId && pollIds.length ? manager.getRepository(MiPollVote).findBy({ noteId: In(pollIds), userId: viewerId }) : [],
				viewerId && ids.length ? manager.getRepository(MiNoteReaction).findBy({ noteId: In(ids), userId: viewerId }) : [],
				viewerId && userIds.length ? manager.getRepository(MiFollowing).findBy({ followeeId: In(userIds), followerId: viewerId }) : [],
			]);
			// User絵文字も同じ集合問い合わせで取得し、作者ごとのDBアクセスを避ける。
			const emojiUsers = userIds.length ? await manager.getRepository(MiUser).find({ where: { id: In(userIds) }, select: { id: true, host: true, emojis: true } }) : [];
			const emojiNames = new Set<string>();
			const hosts = [...new Set([...rows.flatMap(n => n.userHost ? [n.userHost] : []), ...emojiUsers.flatMap(u => u.host ? [u.host] : [])])];
			for (const name of [...rows.flatMap(n => [...n.emojis, ...Object.keys(n.reactions)]), ...[...buffered.values()].flatMap(b => Object.keys(b.deltas)), ...emojiUsers.flatMap(u => u.emojis)]) {
				const bareName = name.replace(/^:/, '').replace(/:$/, '');
				emojiNames.add(bareName.split('@')[0]);
				const match = name.match(/@([\w.-]+):?$/);
				if (match && match[1] !== '.') {
					const host = domainToASCII(match[1].toLowerCase());
					if (host) {
						hosts.push(host);
					}
				}
			}
			const emojiUrls = new Map((hosts.length ? await manager.getRepository(MiEmoji).findBy({ host: In([...new Set(hosts)]), name: In([...emojiNames]) }) : []).map(e => [`${e.name}@${e.host}`, e.publicUrl || e.originalUrl]));
			return {
				notes, authors: await readNoteAuthors(manager, userIds, viewerId, meta, options, now, emojiUrls),
				files: new Map(files.map(file => [file.id, noteFileView(file, meta.proxyRemoteFiles, options)])),
				channels: new Map(channels.map(c => [c.id, { id: c.id, name: c.name, color: c.color, isSensitive: c.isSensitive, allowRenoteToExternal: c.allowRenoteToExternal, userId: c.userId }])),
				polls: new Map(polls.map(p => [p.noteId, { multiple: p.multiple, expiresAt: p.expiresAt?.toISOString() ?? null, choices: p.choices, votes: p.votes, myChoices: votes.filter(v => v.noteId === p.noteId).map(v => v.choice) }])),
				myReactions: new Map(reactions.map(r => [r.noteId, r.reaction])), buffered,
				followedAuthorIds: new Set(followings.map(f => f.followeeId)), emojiUrls, localHost: new URL(options.url).host,
				ugcVisibilityForVisitor: meta.ugcVisibilityForVisitor,
			};
		},
	};
}
