/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
const legacies: Readonly<Record<string, string>> = {
	like: '👍', love: '❤', laugh: '😆', hmm: '🤔', surprise: '😮', congrats: '🎉', angry: '💢',
	confused: '😥', rip: '😇', pudding: '🍮', star: '⭐',
};

export function normalizeReaction(value: string): string {
	const custom = value.match(/^:([\w+-]+)(?:@([\w.-]+))?:$/);
	if (custom) {
		return `:${custom[1]}@${custom[2] ?? '.'}:`;
	}
	return Object.hasOwn(legacies, value) ? legacies[value] : value;
}

export function mergeReactions(saved: Record<string, number>, deltas: Record<string, number>): Record<string, number> {
	const merged = new Map(Object.entries(saved));
	for (const [key, count] of Object.entries(deltas)) {
		merged.set(key, (merged.get(key) ?? 0) + count);
	}
	const converted = new Map<string, number>();
	for (const [key, count] of merged) {
		if (count > 0) {
			const normalized = normalizeReaction(key);
			converted.set(normalized, (converted.get(normalized) ?? 0) + count);
		}
	}
	return Object.fromEntries(converted);
}
