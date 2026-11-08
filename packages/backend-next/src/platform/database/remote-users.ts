/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createActorRefresher } from '../../modules/federation/public.js';
import { IsNull } from 'typeorm';
import { MiUser, MiUserProfile, MiUserPublickey, MiFollowing } from 'backend-upstream/entities';
import { createTransactionRunner } from './transaction-runner.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { Account, RemoteUserFacts, RemoteActorCreateScope, RemoteActorPlan } from '../../modules/federation/public.js';

function facts(user: MiUser | null): RemoteUserFacts | null {
	return user && { id: user.id, username: user.username, host: user.host, uri: user.uri, lastFetchedAtMs: user.lastFetchedAt?.getTime() ?? null, isDeleted: user.isDeleted, movedToUri: user.movedToUri };
}

export function createRemoteUserRepository(manager: EntityManager) {
	const users = manager.getRepository(MiUser);
	return {
		readByAccount: async (account: Account) => facts(await users.findOneBy({ usernameLower: account.username, host: account.host ?? IsNull() })),
		readByUri: async (uri: string) => facts(await users.findOneBy({ uri })),
		readLocal: async (id: string) => facts(await users.findOneBy({ id, host: IsNull(), isDeleted: false })),
		async markAttempt(id: string, now: number): Promise<void> {
			await users.update(id, { lastFetchedAt: new Date(now) });
		},
		async repairUri(id: string, uri: string): Promise<void> {
			await users.update(id, { uri });
		},
		refreshActor: createActorRefresher({
			updateUser: async (id, user) => !!(await users.update({ id, isDeleted: false }, user)).affected,
			async updatePublickey(id, key) {
				await manager.getRepository(MiUserPublickey).update({ userId: id }, key);
			},
			async updateProfile(id, profile) {
				await manager.getRepository(MiUserProfile).update({ userId: id }, profile);
			},
			async updateFollowing(id, sharedInbox) {
				await manager.getRepository(MiFollowing).update({ followerId: id }, { followerSharedInbox: sharedInbox });
			},
		}),
	};
}
export function createRemoteActorTransactions(source: DataSource) {
	const transactions = createTransactionRunner(source, manager => manager);
	return {
		run<T>(work: (scope: RemoteActorCreateScope) => Promise<T>) {
			return transactions.run(async manager => {
				let active = true;
				const assertActive = () => {
					if (!active) {
						throw new Error('The actor write transaction has ended');
					}
				};
				const scope: RemoteActorCreateScope = {
					async insertUser(user) {
						assertActive();
						await manager.getRepository(MiUser).insert(new MiUser(user));
					},
					async insertProfile(profile) {
						assertActive();
						await manager.getRepository(MiUserProfile).insert(new MiUserProfile(profile));
					},
					async insertPublickey(key) {
						assertActive();
						await manager.getRepository(MiUserPublickey).insert(new MiUserPublickey(key));
					},
				};
				try {
					return await work(scope);
				} finally {
					active = false;
				}
			});
		}
	};
}
