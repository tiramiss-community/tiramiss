/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAccessToken, MiApp, MiMeta, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createIdCodec } from '../../src/platform/id-codec.js';
import type { DataSource } from 'typeorm';

export async function seedRoleHttp(source: DataSource) {
	const codec = createIdCodec('aidx');
	const now = Date.now();
	const actors: Record<string, { id: string; token: string }> = {};
	for (const [i, name] of ['root', 'ordinary', 'moderator', 'administrator', 'suspended', 'expired'].entries()) {
		const id = codec.newId(now - 100000);
		const token = `native${String(i).padStart(10, '0')}`;
		actors[name] = { id, token };
		await source.getRepository(MiUser).insert({ id, username: name, usernameLower: name, token, isSuspended: name === 'suspended' });
	}
	await source.getRepository(MiMeta).insert({ id: 'singleton', rootUserId: actors.root.id });
	const roleId = codec.newId(now - 10000);
	await source.getRepository(MiRole).insert({ id: roleId, name: 'target', description: 'keep', updatedAt: new Date(now), lastUsedAt: new Date(now - 100) });
	for (const name of ['moderator', 'administrator', 'suspended', 'expired']) {
		const id = codec.newId(now - 10000);
		await source.getRepository(MiRole).insert({ id, name, description: '', isModerator: name === 'moderator', isAdministrator: name !== 'moderator', updatedAt: new Date(now), lastUsedAt: new Date(now) });
		await source.getRepository(MiRoleAssignment).insert({ id: codec.newId(now), roleId: id, userId: actors[name].id, expiresAt: name === 'expired' ? new Date(0) : null });
	}
	for (const [name, user, permission] of [
		['readScope', 'root', ['read:admin:roles']], ['writeScope', 'root', ['write:admin:roles']], ['ordinaryNoScope', 'ordinary', []],
	] as const) {
		const token = `access-token-${name}-120`;
		actors[name] = { id: actors[user].id, token };
		await source.getRepository(MiAccessToken).insert({ id: codec.newId(now), userId: actors[user].id, token, hash: `hash-${name}`, permission: [...permission] });
	}
	const appId = codec.newId(now);
	await source.getRepository(MiApp).insert({ id: appId, name: 'probe', description: '', secret: 'test-only', permission: ['read:admin:roles'] });
	await source.getRepository(MiAccessToken).insert({ id: codec.newId(now), userId: actors.root.id, appId, token: 'app-token-probe-120', hash: 'app-hash-probe-120', permission: ['write:admin:roles'] });
	actors.appRead = { id: actors.root.id, token: 'APP-HASH-PROBE-120' };
	actors.invalid = { id: '', token: 'invalid-token-120' };
	return { actors, roleId, codec };
}
