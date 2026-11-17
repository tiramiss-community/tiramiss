/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';

export interface UserMemoRow {
	id: string;
	userId: string;
	targetUserId: string;
	memo: string;
}

/** Private read material for a future detailed-user reader; viewer identity is explicit on every read. */
export interface UserMemoReader {
	read(viewerId: string | null, targetUserId: string): Promise<string | null>;
}

export interface UserMemoPorts {
	readActor(userId: string): Promise<AccessFacts>;
	targetExists(userId: string): Promise<boolean>;
	readPrevious(userId: string, targetUserId: string): Promise<{ id: string } | null>;
	insert(row: UserMemoRow): Promise<void>;
	update(row: UserMemoRow): Promise<void>;
	delete(userId: string, targetUserId: string): Promise<void>;
	newId(): string;
}

export class UserMemoTargetMissing extends Error {
	readonly code = 'NO_SUCH_USER';
	readonly id = '6fef56f3-e765-4957-88e5-c6f65329b8a5';
	constructor() {
		super('No such user.');
	}
}

const input = compileInput<{ userId: string; memo: string | null }>({
	type: 'object',
	properties: { userId: { type: 'string', format: 'misskey:id' }, memo: { type: 'string', nullable: true } },
	required: ['userId', 'memo'],
});

export function createUserMemo(ports: UserMemoPorts) {
	return {
		async update(access: AccessRequest, raw: unknown): Promise<void> {
			const actor = requireCredential(access.credential);
			access.authorize(await ports.readActor(actor.userId));
			const params = input(raw);
			if (!await ports.targetExists(params.userId)) {
				throw new UserMemoTargetMissing();
			}
			if (params.memo === '' || params.memo == null) {
				await ports.delete(actor.userId, params.userId);
				return;
			}
			const previous = await ports.readPrevious(actor.userId, params.userId);
			const row = { id: previous?.id ?? ports.newId(), userId: actor.userId, targetUserId: params.userId, memo: params.memo };
			if (previous) {
				await ports.update(row);
			} else {
				await ports.insert(row);
			}
		},
	};
}
