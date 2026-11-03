/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { IsNull } from 'typeorm';
import { MiSystemAccount, MiUsedUsername, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import { DiagnosticError } from '../diagnostic-error.js';
import { generateRsaKeyPair } from '../key-pair.js';
import { readMeta } from './meta.js';
import type { DataSource } from 'typeorm';

export const systemAccountTypes = ['actor', 'relay', 'proxy'] as const;
export type SystemAccountType = typeof systemAccountTypes[number];

export interface SystemAccount {
	id: string;
	username: string;
}

const cacheTtlMs = 1000 * 60 * 10;
const tokenChars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 本家のsecureRndstr(16)と同じ文字の偏りを残す。ネイティブトークンは長さ16で識別されるため、長さも変えない。
function generateNativeUserToken(): string {
	let token = '';
	for (let i = 0; i < 16; i++) {
		const index = Math.min(Math.floor((randomBytes(1).readUInt8(0) / 0xFF) * tokenChars.length), tokenChars.length - 1);
		token += tokenChars.charAt(index);
	}
	return token;
}

export function createSystemAccountEnsurer(options: {
	dataSource: DataSource;
	newId: (atMs: number) => string;
	clock?: () => number;
}): (type: SystemAccountType) => Promise<SystemAccount> {
	const { dataSource, newId, clock = Date.now } = options;
	const cache = new Map<SystemAccountType, { storedAt: number; account: SystemAccount }>();

	const create = async (type: SystemAccountType): Promise<SystemAccount> => {
		// 本家と同じく名前に `.` を含める。表現側がこれでシステムアカウントを判別する。
		const username = `system.${type}`;
		const { name } = await readMeta(dataSource.manager);
		const salt = await bcrypt.genSalt(8);
		const password = await bcrypt.hash(randomUUID(), salt);
		const token = generateNativeUserToken();
		const keyPair = await generateRsaKeyPair();

		// 共有のadapterはtransactionを開かない規則の、唯一の例外（docs/backend-next/federation-base-contract.md）。
		// 本家と同じく呼び出し元のtransactionに参加せず、遅延作成をここで確定する。
		// ロックは取らない。同時の初回作成は一意制約違反として呼び出し元へ伝わる。
		return await dataSource.transaction(async manager => {
			const existing = await manager.findOne(MiUser, {
				select: { id: true, username: true },
				where: { usernameLower: username.toLowerCase(), host: IsNull() },
			});
			if (existing !== null) {
				return { id: existing.id, username: existing.username };
			}

			const id = newId(clock());
			await manager.insert(MiUser, {
				id,
				username,
				usernameLower: username.toLowerCase(),
				host: null,
				token,
				isLocked: true,
				isExplorable: false,
				isBot: true,
				name,
			});
			await manager.insert(MiUserKeypair, { userId: id, publicKey: keyPair.publicKeyPem, privateKey: keyPair.privateKeyPem });
			await manager.insert(MiUserProfile, { userId: id, autoAcceptFollowed: false, password });
			await manager.insert(MiUsedUsername, { createdAt: new Date(clock()), username: username.toLowerCase() });
			await manager.insert(MiSystemAccount, { id: newId(clock()), userId: id, type });
			return { id, username };
		});
	};

	return async (type) => {
		const cached = cache.get(type);
		if (cached !== undefined && clock() - cached.storedAt <= cacheTtlMs) {
			return { ...cached.account };
		}

		// 移行済みのデータでは actor・relay が instance.actor・relay.actor のまま紐付くため、名前では引かない。
		const linked = await dataSource.getRepository(MiSystemAccount).findOne({
			where: { type },
			relations: { user: true },
		});
		let account: SystemAccount;
		if (linked === null) {
			account = await create(type);
		} else if (linked.user === null) {
			throw new DiagnosticError('SYSTEM_ACCOUNT_USER_MISSING', { type });
		} else {
			account = { id: linked.user.id, username: linked.user.username };
		}

		cache.set(type, { storedAt: clock(), account });
		return { ...account };
	};
}
