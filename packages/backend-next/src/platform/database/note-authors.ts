/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In } from 'typeorm';
import { MiUser, MiRole, MiRoleAssignment, MiAvatarDecoration, MiInstance } from 'backend-upstream/entities';
import { evaluateCondition, evaluatePrivileges, selectApplicableRoles } from '../../modules/role/public.js';
import { populateEmojis } from '../../modules/note/public.js';
import { roleDefinition } from './role-mapping.js';
import type { EntityManager } from 'typeorm';
import type { MiMeta } from 'backend-upstream/entities';
import type { AuthorFacts, NoteViewMaterials } from '../../modules/note/public.js';

export async function readNoteAuthors(manager: EntityManager, ids: readonly string[], viewerId: string | null, meta: MiMeta,
	options: { url: string; createdAtFromId(id: string): number }, now: number, emojiUrls: NoteViewMaterials['emojiUrls']) {
	const userIds = [...new Set([...ids, ...(viewerId ? [viewerId] : [])])];
	const users = await manager.getRepository(MiUser).findBy({ id: In(userIds) });
	const roles = (await manager.getRepository(MiRole).find()).map(roleDefinition);
	const assignments = (await manager.getRepository(MiRoleAssignment).findBy({ userId: In(userIds) })).map(row => ({
		id: row.id, userId: row.userId, roleId: row.roleId, expiresAtMs: row.expiresAt?.getTime() ?? null,
	}));
	const decorationIds = [...new Set(users.flatMap(user => user.avatarDecorations.map(d => d.id)))];
	const hosts = [...new Set(users.flatMap(user => user.host ? [user.host] : []))];
	const decorations = new Map((decorationIds.length ? await manager.getRepository(MiAvatarDecoration).findBy({ id: In(decorationIds) }) : []).map(row => [row.id, row.url]));
	const instances = new Map((hosts.length ? await manager.getRepository(MiInstance).findBy({ host: In(hosts) }) : []).map(row => [row.host, row]));
	const facts = (user: MiUser) => ({ userId: user.id, host: user.host, createdAtMs: options.createdAtFromId(user.id),
		isSuspended: user.isSuspended, isLocked: user.isLocked, isBot: user.isBot, isCat: user.isCat, isExplorable: user.isExplorable,
		followersCount: user.followersCount, followingCount: user.followingCount, notesCount: user.notesCount });
	const viewer = users.find(user => user.id === viewerId);
	const moderator = viewer ? evaluatePrivileges(viewer.id, meta.rootUserId, selectApplicableRoles(roles, assignments, facts(viewer), now)).isModerator : false;
	const localHost = new URL(options.url).host;
	return new Map<string, AuthorFacts>(users.filter(user => ids.includes(user.id)).map(user => {
		const assignedIds = new Set(assignments.filter(a => a.userId === user.id && (a.expiresAtMs === null || a.expiresAtMs > now)).map(a => a.roleId));
		const assigned = roles.filter(role => assignedIds.has(role.id));
		// Badge条件はasBadgeのロールだけを評価し、本家同様に手動/条件付きの重複を保持する。
		const badges = [...assigned.filter(r => r.asBadge), ...roles.filter(r => r.asBadge && r.target === 'conditional' && evaluateCondition(r.condFormula, facts(user), assigned, now))];
		const instance = user.host ? instances.get(user.host) : undefined;
		const elapsed = user.lastActiveDate ? now - user.lastActiveDate.getTime() : null;
		return [user.id, {
			id: user.id, host: user.host, requireSigninToViewContents: user.requireSigninToViewContents,
			makeNotesFollowersOnlyBefore: user.makeNotesFollowersOnlyBefore, makeNotesHiddenBefore: user.makeNotesHiddenBefore,
			view: {
				id: user.id, name: user.name, username: user.username, host: user.host,
				avatarUrl: (user.avatarId === null ? null : user.avatarUrl) ?? ((user.host === null || user.host === localHost) && user.username.includes('.') && meta.iconUrl
					? meta.iconUrl : `${options.url}/identicon/${user.username.toLowerCase()}@${user.host ?? localHost}`),
				avatarBlurhash: user.avatarId === null ? null : user.avatarBlurhash,
				avatarDecorations: user.avatarDecorations.filter(d => decorations.has(d.id)).map(d => ({ id: d.id,
					...(d.angle ? { angle: d.angle } : {}), ...(d.flipH ? { flipH: d.flipH } : {}),
					...(d.offsetX ? { offsetX: d.offsetX } : {}), ...(d.offsetY ? { offsetY: d.offsetY } : {}), url: decorations.get(d.id)! })),
				isBot: user.isBot, isCat: user.isCat,
				...(user.requireSigninToViewContents ? { requireSigninToViewContents: true } : {}),
				...(user.makeNotesFollowersOnlyBefore !== null ? { makeNotesFollowersOnlyBefore: user.makeNotesFollowersOnlyBefore } : {}),
				...(user.makeNotesHiddenBefore !== null ? { makeNotesHiddenBefore: user.makeNotesHiddenBefore } : {}),
				...(instance ? { instance: { name: instance.name, softwareName: instance.softwareName, softwareVersion: instance.softwareVersion, iconUrl: instance.iconUrl, faviconUrl: instance.faviconUrl, themeColor: instance.themeColor } } : {}),
				emojis: populateEmojis(user.emojis, user.host, { emojiUrls, localHost }),
				onlineStatus: user.hideOnlineStatus || elapsed === null ? 'unknown' : elapsed < 600000 ? 'online' : elapsed < 259200000 ? 'active' : 'offline',
				...(meta.showRoleBadgesOfRemoteUsers || user.host === null ? { badgeRoles: badges.filter(r => r.isPublic || moderator).sort((a, b) => b.displayOrder - a.displayOrder).map(r => ({ name: r.name, iconUrl: r.iconUrl, displayOrder: r.displayOrder })) } : {}),
			},
		}];
	}));
}
