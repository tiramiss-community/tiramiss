/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import { createEmojiAdmin, EmojiPolicyDenied } from '../../../src/modules/emoji/admin.js';
import type { EmojiAdminPorts } from '../../../src/modules/emoji/admin.js';

const credential = { userId: 'actor', native: true as const };
const access = () => createAccessRequest({ requireCredential: true, kind: 'read:admin:emoji' }, credential);

function ports(facts = { isSuspended: false, isModerator: false, isAdministrator: false, canManageCustomEmojis: false }): EmojiAdminPorts {
	return {
		readActor: async () => facts,
		list: async () => {
			throw new Error('unexpected emoji read');
		},
		listV2: async () => {
			throw new Error('unexpected emoji read');
		},
		roles: async () => {
			throw new Error('unexpected role read');
		},
		idFromDate: () => 'cursor',
	};
}

test('emoji policy denies before malformed input or emoji reads', async () => {
	const application = createEmojiAdmin(ports());
	await expect(application.list(access(), { limit: 0 }, 0)).rejects.toBeInstanceOf(EmojiPolicyDenied);
	await expect(application.listV2(access(), { limit: 0 }, 0)).rejects.toBeInstanceOf(EmojiPolicyDenied);
});
test('suspension wins over policy denial and administrator bypass', async () => {
	const application = createEmojiAdmin(ports({ isSuspended: true, isModerator: true, isAdministrator: true, canManageCustomEmojis: false }));
	await expect(application.list(access(), {}, 0)).rejects.toHaveProperty('reason', 'YOUR_ACCOUNT_SUSPENDED');
});
test('administrator bypasses emoji policy and reaches validated reader', async () => {
	const application = createEmojiAdmin(ports({ isSuspended: false, isModerator: true, isAdministrator: true, canManageCustomEmojis: false }));
	await expect(application.list(access(), {}, 0)).rejects.toThrow('unexpected emoji read');
});
