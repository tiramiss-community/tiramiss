/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

interface CreatedNote {
	userId: string;
	user: { isBot: boolean };
	reply?: { repliesCount: number };
	renote?: { userId: string; renoteCount: number };
}

// 作成応答の入れ子は本家と同じく加算前の値なので、保存後処理を終えた show では返信先・Renote 対象の count だけが進む。
export function afterPostSave<T extends CreatedNote>(createdNote: T): T {
	const expected = structuredClone(createdNote);
	if (expected.reply) {
		expected.reply.repliesCount++;
	}
	if (expected.renote && expected.renote.userId !== expected.userId && !expected.user.isBot) {
		expected.renote.renoteCount++;
	}
	return expected;
}
