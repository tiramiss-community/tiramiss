/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull, Not } from 'typeorm';
import { MiModerationLog, MiNote, MiUser } from 'backend-upstream/entities';
import { evaluatePolicies, evaluatePrivileges, selectApplicableRoles } from '../../modules/role/public.js';
import { isPureRenote } from '../../modules/federation/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import type { EntityManager } from 'typeorm';
import type { DeletedNoteSnapshot } from '../../modules/note/public.js';
import type { DeliveryUser } from '../../modules/federation/public.js';

export function createNoteDeleter(manager: EntityManager, createdAtFromId: (id: string) => number) {
	return {
		async readActor(userId: string, now: number) {
			if (!await manager.getRepository(MiUser).existsBy({ id: userId, host: IsNull() })) {
				return null;
			}
			// 削除資格は cache の有効期限を待たず、操作時点の role と割り当てから判断する。
			const facts = await readRoleAuthorizationFacts(manager, userId, createdAtFromId);
			const applicable = selectApplicableRoles(facts.roles, facts.assignments, facts.user, now);
			const policies = evaluatePolicies({ userId, roles: applicable, basePolicies: facts.instance.basePolicies, uploadLimitBytes: 0 });
			return { isSuspended: facts.user.isSuspended, rateLimitFactor: policies.rateLimitFactor, isModerator: evaluatePrivileges(userId, facts.instance.rootUserId, applicable).isModerator };
		},
		async readNote(id: string): Promise<DeletedNoteSnapshot | null> {
			const row = await manager.getRepository(MiNote).findOneBy({ id });
			if (row === null) {
				return null;
			}
			const author = await manager.getRepository(MiUser).findOneByOrFail({ id: row.userId });
			const original = isPureRenote(row) ? await manager.getRepository(MiNote).findOneBy({ id: row.renoteId! }) : null;
			return {
				id: row.id, userId: row.userId, authorHost: author.host, authorUsername: author.username, localOnly: row.localOnly,
				replyId: row.replyId, renoteUserId: row.renoteUserId,
				note: {
					id: row.id, userId: row.userId, createdAtMs: createdAtFromId(row.id), text: row.text, cw: row.cw, visibility: row.visibility,
					replyId: row.replyId, renoteId: row.renoteId, renoteUserHost: row.renoteUserHost, fileIds: row.fileIds,
					hasPoll: row.hasPoll, tags: row.tags, mentionedRemoteUsers: JSON.parse(row.mentionedRemoteUsers),
				},
				renote: original === null ? null : { id: original.id, uri: original.uri },
				auditNote: { ...row },
			};
		},
		async decrementReplies(noteId: string): Promise<void> {
			await manager.getRepository(MiNote).decrement({ id: noteId }, 'repliesCount', 1);
		},
		async deleteNote(noteId: string, authorId: string): Promise<void> {
			await manager.getRepository(MiNote).delete({ id: noteId, userId: authorId });
		},
	};
}

export async function readDeletionConcernedUsers(manager: EntityManager, snapshot: DeletedNoteSnapshot): Promise<DeliveryUser[]> {
	const uris = snapshot.note.mentionedRemoteUsers.map(user => user.uri);
	const where = [
		...(uris.length > 0 ? [{ uri: In(uris) }] : []),
		...(snapshot.renoteUserId !== null ? [{ id: snapshot.renoteUserId }] : []),
	];
	const mentioned = where.length === 0 ? [] : await manager.getRepository(MiUser).find({ where });
	// 本家の自己参照 FK は既に廃止済み。対象 Note の削除後も、残る返信・Renote を同じ ID から照会できる。
	const concerned = await manager.getRepository(MiNote).find({
		where: [{ replyId: snapshot.id, userHost: Not(IsNull()) }, { renoteId: snapshot.id, userHost: Not(IsNull()) }],
		relations: { user: true },
	});
	return [...mentioned, ...concerned.map(note => note.user!)]
		.map(user => ({ id: user.id, host: user.host, inbox: user.inbox, sharedInbox: user.sharedInbox }));
}

export async function appendNoteDeleteAudit(manager: EntityManager, input: {
	snapshot: DeletedNoteSnapshot; actorId: string; occurredAtMs: number;
}, newId: (now: number) => string): Promise<void> {
	const { snapshot } = input;
	// QueryDeepPartialEntity は任意の JSONB 値を表せないため、JSON 値だけを parameter として渡す。
	await manager.getRepository(MiModerationLog).createQueryBuilder().insert().values({
		id: newId(input.occurredAtMs), userId: input.actorId, type: 'deleteNote', info: () => 'CAST(:info AS jsonb)',
	}).setParameter('info', JSON.stringify({ noteId: snapshot.id, noteUserId: snapshot.userId, noteUserUsername: snapshot.authorUsername, noteUserHost: snapshot.authorHost, note: snapshot.auditNote })).execute();
}
