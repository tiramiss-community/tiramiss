/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect } from 'vitest';

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

// compatibility/note の README にある正規化規則。$名・$time・$origin と実際の値を対応付ける。
export function createNoteContract(options: {
	idFields: Set<string>;
	timeFields: Set<string>;
	origin(): string;
	create(input: object, actor: string): Response | Promise<Response>;
	// 保存後処理の完了を待つ。
	settle(): Promise<void>;
}) {
	const ids: Record<string, string> = {};
	const symbols = new Map<string, string>();

	function remember(name: string, id: string): string {
		ids[name] = id;
		symbols.set(id, `$${name}`);
		return id;
	}

	function normalize(value: unknown, key = ''): unknown {
		if (value instanceof Date) {
			return '$time';
		}
		if (Array.isArray(value)) {
			return value.map(v => normalize(v, key));
		}
		if (value !== null && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
		}
		if (typeof value === 'string') {
			if (options.idFields.has(key) && symbols.has(value)) {
				return symbols.get(value);
			}
			return options.timeFields.has(key) ? '$time' : value.replaceAll(options.origin(), '$origin');
		}
		return value;
	}

	// probe（reference-note.e2e.ts の params）と同じく、未解決の $名で別の入力を送らない。
	function resolve(value: unknown): unknown {
		if (typeof value === 'string' && value.startsWith('$')) {
			expect(ids[value.slice(1)], `unresolved input ${value}`).toBeDefined();
			return ids[value.slice(1)];
		}
		if (Array.isArray(value)) {
			return value.map(resolve);
		}
		if (value !== null && typeof value === 'object') {
			const repeat = (value as { $repeat?: [string, number] }).$repeat;
			if (repeat) {
				return repeat[0].repeat(repeat[1]);
			}
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
		}
		return value;
	}

	// probe は保存後の count が収束するまで次の入力を送らないため、同じく保存後処理の完了を待つ。
	async function prepare(name: string, input: object, actor: string): Promise<void> {
		const response = await options.create(input, actor);
		expect(response.status, name).toBe(200);
		remember(name, (await response.json()).createdNote.id);
		await options.settle();
	}

	return { ids, remember, normalize, resolve, prepare };
}
